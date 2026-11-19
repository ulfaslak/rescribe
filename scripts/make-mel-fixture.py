# Regenerates src/lib/asr/mel.fixture.json: Hugging Face's WhisperFeatureExtractor on two
# deterministic signals, sampled every 997th value, for mel.test.ts. Needs `transformers` and
# `numpy` in any Python env:  python3 scripts/make-mel-fixture.py
import json, numpy as np
from transformers import WhisperFeatureExtractor

def signal(seconds):
    t = np.arange(int(seconds * 16000)) / 16000
    x = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.2 * np.sin(2 * np.pi * 1730 * t * (1 + 0.1 * t))
    x += 0.05 * np.sin(np.arange(len(t)) * 12.9898) # deterministic pseudo-noise
    return x.astype(np.float32)

out = {"stride": 997, "cases": []}
for seconds in (3.3, 31.0):
    x = signal(seconds)
    for n_mels, repo in ((80, "openai/whisper-base"), (128, "openai/whisper-large-v3-turbo")):
        fe = WhisperFeatureExtractor.from_pretrained(repo)
        f = fe(x, sampling_rate=16000, return_tensors="np").input_features[0].reshape(-1)
        out["cases"].append({"seconds": seconds, "nMels": n_mels, "values": [round(float(v), 6) for v in f[::997]]})
json.dump(out, open("src/lib/asr/mel.fixture.json", "w"))
