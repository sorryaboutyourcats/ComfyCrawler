"""Finds the beat grid of a music track for the /trailer page (see trailer.js).

    python tools/trailer_beats.py sounds/trailer_candidates/*.wav      # compare candidates
    python tools/trailer_beats.py sounds/trailer_music.wav --write     # set trailer.json's music
    python tools/trailer_beats.py sounds/trailer2_music.wav --write trailer2.json

The trailer cuts on beats, so it needs to know where they are. Every cue in trailer.js is
written as a beat index, and trailer.json carries the track's beat times in seconds, measured
here rather than trusted from the prompt: the music model is asked for 128 BPM and lands near
it, not on it.

Method (plain numpy, no librosa): a spectral-flux onset envelope, an autocorrelation tempo
estimate weighted towards 128 BPM, then Ellis's dynamic-programming beat tracker, which lets
the grid follow a track that drifts a little instead of snapping to one fixed tempo.

It also prints how steady the track is (the spread of the beat-to-beat gaps) and how loud each
bar is, which is what picking a trailer track and placing its cuts actually needs.
"""
import argparse
import glob
import json
import os
import sys
import wave

import numpy as np

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.normpath(os.path.join(TOOLS_DIR, os.pardir))

HOP = 512
N_FFT = 2048
TARGET_BPM = 128.0          # what the candidate prompts ask for; the tempo prior centres here
MIN_BPM, MAX_BPM = 70.0, 190.0
TIGHTNESS = 100.0           # Ellis's alpha: how hard the tracker holds to the estimated period


def read_wav(path):
    """Any 16-bit PCM WAV -> (mono float32, rate)."""
    with wave.open(path, "rb") as wf:
        rate, channels, width = wf.getframerate(), wf.getnchannels(), wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())
    if width != 2:
        raise ValueError(f"{path}: {width * 8}-bit audio, expected 16-bit")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    return x, rate


def onset_envelope(x, rate):
    """Spectral flux on a log-compressed STFT, one value per HOP samples."""
    win = np.hanning(N_FFT).astype(np.float32)
    frames = 1 + max(0, (len(x) - N_FFT) // HOP)
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * win, axis=1))
    logspec = np.log1p(100.0 * spec)
    flux = np.maximum(0.0, np.diff(logspec, axis=0)).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    # Take away the slowly moving floor so a loud section doesn't read as one long onset.
    k = max(1, int(round(0.5 * rate / HOP)))
    floor = np.convolve(flux, np.ones(k) / k, mode="same")
    env = np.maximum(0.0, flux - floor)
    peak = env.max()
    return env / peak if peak > 0 else env


def estimate_period(env, rate):
    """Beat period in envelope frames (fractional), from a tempo-weighted autocorrelation."""
    fps = rate / HOP
    lo, hi = int(fps * 60.0 / MAX_BPM), int(np.ceil(fps * 60.0 / MIN_BPM))
    e = env - env.mean()
    ac = np.correlate(e, e, mode="full")[len(e) - 1:]
    lags = np.arange(lo, hi + 1)
    bpm = 60.0 * fps / lags
    prior = np.exp(-0.5 * (np.log2(bpm / TARGET_BPM) / 0.9) ** 2)
    score = ac[lo:hi + 1] * prior
    i = int(np.argmax(score))
    # Parabolic refinement between neighbouring lags.
    if 0 < i < len(score) - 1:
        a, b, c = score[i - 1], score[i], score[i + 1]
        denom = a - 2 * b + c
        shift = 0.5 * (a - c) / denom if denom != 0 else 0.0
    else:
        shift = 0.0
    return lags[i] + shift


def track_beats(env, period):
    """Ellis (2007) dynamic-programming beat tracker. Returns beat positions in frames."""
    n = len(env)
    score = env.copy()
    back = -np.ones(n, dtype=int)
    p = period
    lo, hi = int(round(p / 2)), int(round(2 * p))
    offsets = np.arange(-hi, -lo + 1)
    penalty = -TIGHTNESS * np.log(-offsets / p) ** 2
    for t in range(n):
        prev = t + offsets
        ok = prev >= 0
        if not ok.any():
            continue
        cand = score[prev[ok]] + penalty[ok]
        j = int(np.argmax(cand))
        if cand[j] > 0:
            score[t] = env[t] + cand[j]
            back[t] = prev[ok][j]
    # Start from the best-scoring frame inside the last period and walk back.
    tail = max(0, n - int(round(p)))
    t = tail + int(np.argmax(score[tail:]))
    beats = [t]
    while back[t] >= 0:
        t = back[t]
        beats.append(t)
    return np.array(beats[::-1])


def analyze(path):
    x, rate = read_wav(path)
    env = onset_envelope(x, rate)
    period = estimate_period(env, rate)
    frames = track_beats(env, period)
    times = frames * HOP / rate
    gaps = np.diff(times)
    # Constant-tempo fit: slope is the average tempo, the residual is how far the real beats
    # wander from a metronome - the number that says whether cuts will feel locked or loose.
    idx = np.arange(len(times))
    slope, icpt = np.polyfit(idx, times, 1)
    resid_ms = float(np.sqrt(np.mean((times - (slope * idx + icpt)) ** 2)) * 1000.0)
    # Per-bar loudness, 4 beats a bar from the first tracked beat.
    bars = []
    for b in range(0, len(times) - 4, 4):
        s, e = int(times[b] * rate), int(times[b + 4] * rate)
        rms = float(np.sqrt(np.mean(x[s:e] ** 2))) if e > s else 0.0
        bars.append(round(20 * np.log10(max(rms, 1e-6)), 1))
    return {
        "file": path,
        "duration": round(len(x) / rate, 3),
        "bpm": round(60.0 / slope, 2),
        "first_beat": round(float(times[0]), 3),
        "beats": [round(float(t), 3) for t in times],
        "gap_cv": round(float(gaps.std() / gaps.mean()), 4) if len(gaps) else None,
        "drift_ms": round(resid_ms, 1),
        "bar_db": bars,
    }


def describe(r):
    return (f"{os.path.basename(r['file'])}: {r['bpm']} BPM, {len(r['beats'])} beats, "
            f"first at {r['first_beat']}s, gap spread {r['gap_cv'] * 100:.1f}%, "
            f"drift {r['drift_ms']} ms RMS\n    bar loudness dB: {r['bar_db']}")


def write_trailer_json(r, target):
    rel = os.path.relpath(os.path.abspath(r["file"]), REPO_DIR).replace(os.sep, "/")
    path = os.path.join(REPO_DIR, target)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["music"] = {"file": rel, "bpm": r["bpm"], "beats": r["beats"]}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"[trailer beats] wrote {len(r['beats'])} beats ({r['bpm']} BPM) for {rel} into {target}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("files", nargs="+")
    ap.add_argument("--write", nargs="?", const="trailer.json", default=None, metavar="JSON",
                    help="store the (single) track's beat grid as that trailer's music "
                         "(default trailer.json; trailer2.json for /trailer2)")
    args = ap.parse_args(argv)
    files = [f for pat in args.files for f in (glob.glob(pat) or [pat])]
    if args.write and len(files) != 1:
        raise SystemExit("--write takes exactly one track")
    for f in files:
        r = analyze(f)
        print(describe(r))
        if args.write:
            write_trailer_json(r, args.write)


if __name__ == "__main__":
    sys.exit(main())
