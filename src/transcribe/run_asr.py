#!/usr/bin/env python3
"""本地语音转写引擎：sherpa-onnx + Qwen3-ASR。

设计要点：
- 完全离线，不发起任何网络请求（模型需事先下载好）。
- 用 Silero VAD 把长音频切成语音段，再逐段识别。这是刚需而非优化：
  Qwen3-ASR 单次可处理的 token 数受 max_total_len 限制，实测 272 秒音频
  直接整段送进去会因为音频占位符超限被截断，输出为空。切成 15 秒以内的
  语音段既能避开该限制，也让时间戳可以精确到句。
- 输出 JSON 给上层（Node）解析，同时可直接写 SRT/TXT。
- 与本项目其它部分一样，不依赖任何非标准库之外的 Python 包，只额外需要
  numpy 与 sherpa-onnx。

用法:
    python run_asr.py --model-dir DIR --audio FILE --output OUT.json [选项]
"""

import argparse
import json
import os
import sys
import time
import wave


def die(msg, code=2):
    """把错误以 JSON 输出到 stdout，让 Node 侧能统一解析，避免只有 stderr。"""
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(code)


def load_wav_mono_16k(path):
    """读取 wav 并返回 (samples:float32, sample_rate)。

    只接受 16-bit PCM。转码统一交给上层 ffmpeg 完成——这样 Python 侧不需要
    引入 soundfile/librosa 之类的重依赖，在 Windows 上也少一类编译问题。
    """
    try:
        with wave.open(path, "rb") as f:
            sr = f.getframerate()
            n = f.getnframes()
            ch = f.getnchannels()
            width = f.getsampwidth()
            raw = f.readframes(n)
    except wave.Error as e:
        die(f"无法读取音频（需要 16-bit PCM wav）: {e}")

    if width != 2:
        die(f"音频位深 {width * 8} bit 不受支持，请先转为 16-bit PCM")
    if sr != 16000:
        die(f"采样率 {sr} Hz 不受支持，请先转为 16000 Hz")
    if ch not in (1, 2):
        die(f"声道数 {ch} 不受支持")

    import numpy as np

    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch == 2:
        # 立体声取均值。直播录像常是单声道，但录屏工具可能给双声道。
        data = data.reshape(-1, 2).mean(axis=1)
    return data, sr


def build_vad(args):
    import sherpa_onnx

    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = args.vad_model
    cfg.silero_vad.threshold = args.vad_threshold
    cfg.silero_vad.min_silence_duration = args.min_silence
    cfg.silero_vad.min_speech_duration = args.min_speech
    # 上限压到 15 秒以内，避免单段音频占位符撑爆 max_total_len。
    cfg.silero_vad.max_speech_duration = args.max_speech
    cfg.sample_rate = 16000
    # 缓冲区按最长单段留余量；过小会在长句处丢帧。
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=120)


def build_recognizer(args):
    import sherpa_onnx

    model = args.model_dir
    return sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
        conv_frontend=os.path.join(model, "conv_frontend.onnx"),
        encoder=os.path.join(model, "encoder.int8.onnx"),
        decoder=os.path.join(model, "decoder.int8.onnx"),
        tokenizer=os.path.join(model, "tokenizer"),
        num_threads=args.threads,
        max_new_tokens=args.max_new_tokens,
        max_total_len=args.max_total_len,
        hotwords=args.hotwords or "",
    )


def split_with_vad(vad, samples):
    """把整段音频按 VAD 切成语音段，返回 [(start_sample, samples), ...]。

    必须分块喂入：VoiceActivityDetector 内部只有固定大小的缓冲，一次性
    accept 长音频会覆盖未取走的结果。
    """
    window = 512  # Silero VAD 的固定窗长（16k 采样率下 32ms）
    segments = []
    for i in range(0, len(samples), window):
        vad.accept_waveform(samples[i:i + window])
        while not vad.empty():
            seg = vad.front
            segments.append((int(seg.start), seg.samples.copy()))
            vad.pop()
    vad.flush()
    while not vad.empty():
        seg = vad.front
        segments.append((int(seg.start), seg.samples.copy()))
        vad.pop()
    return segments


def merge_short(segments, sr, gap_sec=0.35, max_sec=15.0):
    """把相邻的短语音段合并，减少碎句。

    VAD 会按静音切得很细，逐段识别会让同一句话被切成好几个字幕条目。
    这里在「间隔小且合并后不超长」时并起来，字幕读起来才连贯。
    """
    if not segments:
        return []
    merged = [list(segments[0])]
    for start, samples in segments[1:]:
        prev_start, prev_samples = merged[-1]
        prev_end = prev_start + len(prev_samples)
        gap = (start - prev_end) / sr
        combined = len(prev_samples) + len(samples)
        if gap <= gap_sec and combined <= max_sec * sr:
            import numpy as np
            merged[-1][1] = np.concatenate([prev_samples, samples])
        else:
            merged.append([start, samples])
    return [(s, x) for s, x in merged]


def fmt_srt_time(seconds):
    if seconds < 0:
        seconds = 0
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(path, items):
    lines = []
    for i, it in enumerate(items, 1):
        lines.append(str(i))
        lines.append(f"{fmt_srt_time(it['start'])} --> {fmt_srt_time(it['end'])}")
        lines.append(it["text"])
        lines.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def write_txt(path, items, with_time=False):
    with open(path, "w", encoding="utf-8") as f:
        for it in items:
            if with_time:
                f.write(f"[{fmt_srt_time(it['start'])}] {it['text']}\n")
            else:
                f.write(it["text"] + "\n")


def main():
    ap = argparse.ArgumentParser(description="Qwen3-ASR 本地转写")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--vad-model", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--output", help="结果 JSON 路径")
    ap.add_argument("--srt", help="同时输出 SRT 字幕")
    ap.add_argument("--txt", help="同时输出纯文本")
    ap.add_argument("--hotwords", default="", help="逗号分隔的热词，提升专名识别")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--max-new-tokens", type=int, default=256)
    ap.add_argument("--max-total-len", type=int, default=1024)
    ap.add_argument("--vad-threshold", type=float, default=0.5)
    ap.add_argument("--min-silence", type=float, default=0.5)
    ap.add_argument("--min-speech", type=float, default=0.25)
    ap.add_argument("--max-speech", type=float, default=15.0)
    ap.add_argument("--no-merge", action="store_true", help="不合并相邻短句")
    args = ap.parse_args()

    if not os.path.isdir(args.model_dir):
        die(f"模型目录不存在: {args.model_dir}")
    if not os.path.isfile(args.vad_model):
        die(f"VAD 模型不存在: {args.vad_model}")
    if not os.path.isfile(args.audio):
        die(f"音频文件不存在: {args.audio}")

    t_start = time.time()
    samples, sr = load_wav_mono_16k(args.audio)
    duration = len(samples) / sr

    try:
        vad = build_vad(args)
        recognizer = build_recognizer(args)
    except ImportError as e:
        die(f"缺少 Python 依赖，请先运行安装脚本: {e}")

    t_vad = time.time()
    segments = split_with_vad(vad, samples)
    if not args.no_merge:
        segments = merge_short(segments, sr, max_sec=args.max_speech)
    vad_elapsed = time.time() - t_vad

    t_asr = time.time()
    items = []
    for start_sample, seg_samples in segments:
        stream = recognizer.create_stream()
        stream.accept_waveform(sr, seg_samples)
        recognizer.decode_stream(stream)
        text = (stream.result.text or "").strip()
        # 纯静音段和口水音会产出空串或单个标点，直接丢弃，否则字幕里全是空条目。
        if not text or text.strip("。，、,.!?！？ ") == "":
            continue
        start = start_sample / sr
        items.append({
            "start": round(start, 3),
            "end": round(min(start + len(seg_samples) / sr, duration), 3),
            "text": text,
        })
    asr_elapsed = time.time() - t_asr

    if args.srt:
        write_srt(args.srt, items)
    if args.txt:
        write_txt(args.txt, items)

    result = {
        "ok": True,
        "duration": round(duration, 3),
        "segments": items,
        "text": "\n".join(it["text"] for it in items),
        "stats": {
            "segmentCount": len(items),
            "speechSeconds": round(sum(it["end"] - it["start"] for it in items), 2),
            "vadSeconds": round(vad_elapsed, 3),
            "asrSeconds": round(asr_elapsed, 3),
            "totalSeconds": round(time.time() - t_start, 3),
            # 实时率：越小越快。0.05 表示 20 倍速。
            "rtf": round((time.time() - t_start) / duration, 4) if duration else None,
        },
    }
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()