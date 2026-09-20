#!/usr/bin/env python3
"""Evaluate a local decision model (Laya) against data/action-cases.jsonl.

Run with the model's own environment:
    ~/.venvs/laya/bin/python scripts/eval-laya.py

Findings from the run on 2026-09-20, kept here so the experiments are not
repeated from scratch:

  control config                 accuracy  false-positives  stop recall
  baseline (none|stop|conv_off)  81%       5/39             4/6
  question-style instructions    54%       21/39            5/6
  criteria with examples         27%       32/39            5/6
  noul decomposition @0.5        -         4/39             4/6
  noul decomposition @0.9        -         2/39             0/6

  permission config              accuracy
  none|allow|always|deny         92%  (zero confident errors)

Conclusions: the original three-way phrasing is the best configuration tried;
question-style instructions and explicit examples both make it dramatically
worse; decomposing into calibrated binary questions does not help either,
because the residual failure is a *semantic* blind spot (mentioning "stop" is
treated as commanding it) at 0.95-1.00 confidence, which no threshold can reach.
All false positives were hand-written negation traps; none were real utterances.
"""
import json
import os
import sys

from laya import Router

DATASET = os.path.expanduser("~/.local/share/opencode/opencode-dictate/dataset.jsonl")
CASES = os.path.join(os.path.dirname(__file__), "..", "data", "action-cases.jsonl")


def rows():
    if os.path.exists(DATASET):
        yield from (json.loads(l) for l in open(DATASET) if l.strip())
    else:
        for line in open(CASES):
            if line.strip():
                c = json.loads(line)
                yield {"text": c["text"], "action": c["action"], "mode": c["mode"], "source": "curated"}


def choice_q(instructions, criteria):
    return {"a": {"type": "choice", "instructions": instructions, "criteria": criteria}}


BASE = choice_q(
    "The speaker is dictating to a coding assistant in hands-free conversation mode. "
    "Decide whether they are giving a control command.",
    {
        "none": "an ordinary request or statement to dictate",
        "stop": "tell the assistant to halt immediately",
        "conversation_off": "leave the hands-free conversation mode",
    },
)


def main():
    router = Router(preload=True, device="cuda")
    data = [r for r in rows() if r["action"] != "nonspeech"]
    control = [r for r in data if r["mode"] in ("control", "unknown")]
    permission = [r for r in data if r["mode"] == "permission"]

    if control:
        correct = false_pos = 0
        prompts = [r for r in control if r["action"] == "prompt"]
        for r in control:
            picked = router.predict({"body": r["text"]}, BASE, model="multilingual")["answers"]["a"]["choice"]
            picked = {"none": "prompt"}.get(picked, picked)
            correct += picked == r["action"]
            if r["action"] == "prompt" and picked != "prompt":
                false_pos += 1
                print(f"  false positive: {r['text'][:50]!r} -> {picked}")
        print(f"  control: {correct}/{len(control)} = {correct/len(control):.0%}, "
              f"false positives {false_pos}/{len(prompts)}")
    if permission:
        correct = sum(
            1
            for r in permission
            if router.predict({"body": r["text"]}, BASE, model="multilingual")["answers"]["a"]["choice"]
            in (r["action"], {"prompt": "none"}.get(r["action"], r["action"]))
        )
        print(f"  permission (baseline phrasing): {correct}/{len(permission)} = {correct/len(permission):.0%}")


if __name__ == "__main__":
    sys.exit(main())
