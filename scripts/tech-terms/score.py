# Counts the lines of lines.json that Whisper (large-v3-turbo, MLX) mishears in a render.mjs output dir:
# a line is misread when any of its terms (lower case, letters and digits only) is missing from the
# transcript. uv run --with mlx-whisper python -I score.py <dir>
import json, sys, os, re, glob
import mlx_whisper
d = sys.argv[1]
lines = json.load(open(os.path.join(os.path.dirname(__file__), "lines.json")))
out, bad = [], 0
for i, line in enumerate(lines):
    t = mlx_whisper.transcribe(os.path.join(d, f"{i:02d}.wav"), path_or_hf_repo="mlx-community/whisper-large-v3-turbo", language="en")["text"].strip()
    key = re.sub(r"[^a-z0-9%]", "", t.lower())
    missing = [alts[0] for alts in line["terms"] if not any(a in key for a in alts)]
    bad += bool(missing)
    out.append({"i": i, "text": line["text"], "heard": t, "missing": missing})
json.dump(out, open(os.path.join(d, "whisper.json"), "w"), indent=1)
for o in out:
    if o["missing"]: print(o["i"], o["missing"], "|", o["heard"])
print(f"misread lines: {bad}/{len(lines)}")
