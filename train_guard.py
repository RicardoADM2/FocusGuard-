#!/usr/bin/env python3
"""Train and export FocusGuard's tiny answer-quality transformer.

Requires the user's existing PyTorch installation. This script never installs
or updates PyTorch. With no --text argument it downloads small public-domain
English text files using only the Python standard library, then synthesizes
scrambled/junk examples. The resulting task is English coherence/noise
screening; it does not determine whether an answer is sincere or emotionally
correct.
"""
from __future__ import annotations

import argparse
import html
import json
import math
import random
import re
import sys
import urllib.request
from collections import Counter, OrderedDict
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from torch.utils.data import DataLoader, TensorDataset


VERSION = 1
DEFAULT_MAX_LENGTH = 128
DEFAULT_VOCAB_SIZE = 6000
DEFAULT_D_MODEL = 64
DEFAULT_HEADS = 4
DEFAULT_D_FF = 128
GUTENBERG = {
    "pride_and_prejudice": "https://www.gutenberg.org/cache/epub/1342/pg1342.txt",
    "sherlock_holmes": "https://www.gutenberg.org/cache/epub/1661/pg1661.txt",
}

# Small seed lexicon. Each token receives a learned sentiment-category vector;
# sentiment is an input feature, never a pass/fail label or required polarity.
POSITIVE_WORDS = set("""able accept accepted achievement admire advance affection affirm
 amazing appreciate appreciated appreciation benefit better brave calm care cared
 caring celebrate certain confidence confident considerate courage courageous
 create created curious delight delighted enjoy enjoyed enough excited fair faithful
 freedom friend friendly generous glad good grateful gratitude happy heal helpful
 hope hopeful improve improved joy joyful kind kindness like liked love loved loyal
 meaningful nice optimism optimistic peace pleased pleasure positive proud purpose
 respect respected safe satisfied secure share sincere solve strength strong support
 supported thank thankful thoughtful trust trusted understand useful value valued
 warm welcome well win willing wise worth worthwhile""".split())
NEGATIVE_WORDS = set("""abandon abandoned angry anxious awful bad betray betrayed bitter blame
 break broken careless chaos cheat cheated collapse confused cruel damage damaged
 danger dark disappointed dishonest disrespect doubt dread dull fail failed failure
 fear fearful foolish frustrate frustrated guilty harm harmed hate hated hurt ignore
 ignored impossible impulsive insecure lose lost lonely loss miserable mistake
 mistakes negative nervous pain painful panic poor regret regretful reject rejected
 resent resentment sad shame ashamed selfish sick stupid stress stressed struggle
 terrible tired toxic tragic unkind unsafe useless worthless worry worried""".split())

TOKEN_RE = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)?|\d+|[^\s]", re.UNICODE)
WORD_RE = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)?|\d+", re.UNICODE)
SPECIAL = ["<pad>", "<unk>", "<cls>"]


def tokens(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def words(text: str) -> list[str]:
    return WORD_RE.findall(text.lower())


def clean_gutenberg(text: str) -> str:
    text = text.replace("\ufeff", "")
    start = re.search(r"\*\*\*\s*START OF (?:THE )?PROJECT GUTENBERG EBOOK[^\n]*\*\*\*", text, re.I)
    if start:
        text = text[start.end():]
    end = re.search(r"\*\*\*\s*END OF (?:THE )?PROJECT GUTENBERG EBOOK", text, re.I)
    if end:
        text = text[:end.start()]
    text = re.sub(r"(?m)^\s*\[[^\]]*(?:Illustration|Illustrations|Footnote)[^\]]*\]\s*$", " ", text, flags=re.I)
    text = re.sub(r"[_*]{1,3}", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def download_sources(cache_dir: Path) -> list[str]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    texts = []
    for name, url in GUTENBERG.items():
        path = cache_dir / f"{name}.txt"
        if not path.exists():
            print(f"Downloading public-domain English text: {name}")
            request = urllib.request.Request(url, headers={"User-Agent": "FocusGuardLocalTrainer/1.0"})
            with urllib.request.urlopen(request, timeout=40) as response:
                path.write_bytes(response.read())
        texts.append(clean_gutenberg(path.read_text(encoding="utf-8", errors="replace")))
    return texts


def read_sources(paths: list[Path], cache_dir: Path) -> list[str]:
    if paths:
        sources = [clean_gutenberg(path.read_text(encoding="utf-8", errors="replace")) for path in paths]
        if not any(sources):
            raise ValueError("The supplied text file(s) contain no readable text.")
        return sources
    try:
        return download_sources(cache_dir)
    except Exception as exc:
        raise RuntimeError(
            "Could not download the default training text. Re-run with --text PATH_TO_ENGLISH_TEXT.txt. "
            f"Download error: {exc}"
        ) from exc


def split_sentences(text: str) -> list[str]:
    pieces = re.split(r"(?<=[.!?])(?:[\"'’”)]*)\s+|\s{2,}", text)
    return [p.strip() for p in pieces if 3 <= len(words(p)) <= 100]


def make_spans(sents: list[str], max_words: int = 92) -> list[str]:
    spans = []
    current: list[str] = []
    n = 0
    for sentence in sents:
        count = len(words(sentence))
        if current and n + count > max_words:
            if n >= 20:
                spans.append(" ".join(current))
            current, n = [], 0
        current.append(sentence)
        n += count
        if n >= 38:
            spans.append(" ".join(current))
            current, n = [], 0
    if current and n >= 20:
        spans.append(" ".join(current))
    return spans


def make_splits(sources: list[str], seed: int) -> tuple[list[str], list[str], list[str]]:
    rng = random.Random(seed)
    split_lists = ([], [], [])
    for source in sources:
        # Split the source before sentence/span generation to reduce overlap leakage.
        n = len(source)
        thirds = (source[:int(n * .80)], source[int(n * .80):int(n * .90)], source[int(n * .90):])
        for target, section in zip(split_lists, thirds):
            target.extend(make_spans(split_sentences(section)))
    for target in split_lists:
        rng.shuffle(target)
    if min(map(len, split_lists)) < 30:
        raise ValueError("Training text is too small. Supply a larger English text file with --text.")
    return tuple(split_lists)


def build_vocab(texts: list[str], max_size: int) -> list[str]:
    counts = Counter(token for text in texts for token in tokens(text))
    for token in POSITIVE_WORDS | NEGATIVE_WORDS:
        counts.setdefault(token, 1)
    body = [word for word, _ in counts.most_common(max_size - len(SPECIAL)) if word not in SPECIAL]
    return SPECIAL + body


def sentiment_category(token: str) -> int:
    token = token.strip("'’").lower()
    if token in POSITIVE_WORDS:
        return 1
    if token in NEGATIVE_WORDS:
        return 2
    return 0


def sentiment_score(token: str) -> float:
    return 1.0 if sentiment_category(token) == 1 else (-1.0 if sentiment_category(token) == 2 else 0.0)


def junk_variant(text: str, kind: str, rng: random.Random, word_bank: list[str]) -> str:
    original = tokens(text)
    if not original:
        return "asdf qwer zxcv " * 12
    if kind == "shuffle":
        out = original[:]
        rng.shuffle(out)
        return " ".join(out)
    if kind == "local_shuffle":
        out = original[:]
        for start in range(0, len(out), 5):
            chunk = out[start:start + 5]
            rng.shuffle(chunk)
            out[start:start + 5] = chunk
        return " ".join(out)
    if kind == "replace":
        out = original[:]
        for i in range(len(out)):
            if rng.random() < .35:
                out[i] = rng.choice(word_bank)
        return " ".join(out)
    if kind == "repeat":
        phrase = original[:rng.randint(2, min(6, len(original)))]
        return " ".join(phrase * max(8, math.ceil(45 / len(phrase))))
    if kind == "padded":
        out = original[:]
        junk = [rng.choice(word_bank) for _ in range(max(8, len(out) // 3))]
        return " ".join(out[:len(out)//2] + junk + out[len(out)//2:])
    if kind == "keysmash":
        out = original[:]
        for i in range(0, len(out), 2):
            out[i] = "".join(rng.choice("asdfjklqweruiopzxcvnm") for _ in range(rng.randint(5, 12)))
        return " ".join(out)
    if kind == "word_salad":
        return " ".join(rng.choice(word_bank) for _ in range(max(22, min(len(original), 75))))
    if kind == "char_scramble":
        out = original[:]
        for i in range(len(out)):
            if len(out[i]) > 3 and rng.random() < .7:
                letters = list(out[i])
                middle = letters[1:-1]
                rng.shuffle(middle)
                out[i] = "".join(letters[:1] + middle + letters[-1:])
        return " ".join(out)
    raise ValueError(kind)


JUNK_TYPES = ["shuffle", "local_shuffle", "replace", "repeat", "padded", "keysmash", "word_salad", "char_scramble"]


def make_examples(positives: list[str], word_bank: list[str], seed: int, per_positive: int = 2):
    rng = random.Random(seed)
    examples = [(text, 1, "real") for text in positives]
    for i, text in enumerate(positives):
        for j in range(per_positive):
            kind = JUNK_TYPES[(i + j + rng.randrange(len(JUNK_TYPES))) % len(JUNK_TYPES)]
            examples.append((junk_variant(text, kind, rng, word_bank), 0, kind))
    rng.shuffle(examples)
    return examples


def encode_examples(examples, word_to_id, sentiment_ids, max_length):
    ids = np.zeros((len(examples), max_length), dtype=np.int64)
    sids = np.zeros((len(examples), max_length), dtype=np.int64)
    mask = np.zeros((len(examples), max_length), dtype=np.bool_)
    labels = np.zeros((len(examples),), dtype=np.float32)
    for row, (text, label, _) in enumerate(examples):
        ids[row, 0] = 2  # <cls>
        mask[row, 0] = True
        seq = tokens(text)[:max_length - 1]
        for col, word in enumerate(seq, start=1):
            token_id = word_to_id.get(word, 1)
            ids[row, col] = token_id
            sids[row, col] = sentiment_ids[token_id]
            mask[row, col] = True
        labels[row] = label
    return ids, sids, mask, labels


class TinyGuard(nn.Module):
    def __init__(self, vocab_size, max_length, d_model=DEFAULT_D_MODEL, n_heads=DEFAULT_HEADS, d_ff=DEFAULT_D_FF):
        super().__init__()
        self.embedding = nn.Embedding(vocab_size, d_model, padding_idx=0)
        self.sentiment_embedding = nn.Embedding(3, d_model)
        self.position_embedding = nn.Embedding(max_length, d_model)
        self.ln1 = nn.LayerNorm(d_model, eps=1e-5)
        self.q = nn.Linear(d_model, d_model)
        self.k = nn.Linear(d_model, d_model)
        self.v = nn.Linear(d_model, d_model)
        self.o = nn.Linear(d_model, d_model)
        self.ln2 = nn.LayerNorm(d_model, eps=1e-5)
        self.ff1 = nn.Linear(d_model, d_ff)
        self.ff2 = nn.Linear(d_ff, d_model)
        self.head = nn.Linear(d_model, 1)
        self.n_heads = n_heads
        self.d_model = d_model

    def forward(self, ids, sentiment_ids, mask):
        batch, length = ids.shape
        positions = torch.arange(length, device=ids.device).unsqueeze(0)
        x = self.embedding(ids) + self.sentiment_embedding(sentiment_ids) + self.position_embedding(positions)
        h = self.ln1(x)
        head_dim = self.d_model // self.n_heads
        q = self.q(h).view(batch, length, self.n_heads, head_dim).transpose(1, 2)
        k = self.k(h).view(batch, length, self.n_heads, head_dim).transpose(1, 2)
        v = self.v(h).view(batch, length, self.n_heads, head_dim).transpose(1, 2)
        scores = (q @ k.transpose(-2, -1)) / math.sqrt(head_dim)
        scores = scores.masked_fill(~mask[:, None, None, :], -1e4)
        attn = scores.softmax(dim=-1)
        context = (attn @ v).transpose(1, 2).contiguous().view(batch, length, self.d_model)
        x = x + self.o(context)
        x = x + self.ff2(F.gelu(self.ff1(self.ln2(x)), approximate="tanh"))
        return self.head(x[:, 0]).squeeze(-1)


def auc_score(labels: np.ndarray, scores: np.ndarray) -> float:
    pos = scores[labels == 1]
    neg = scores[labels == 0]
    if not len(pos) or not len(neg):
        return float("nan")
    # Pairwise AUC, fine for the modest held-out set.
    return float(((pos[:, None] > neg[None, :]).mean()) + .5 * (pos[:, None] == neg[None, :]).mean())


def predict(model, data, device, batch_size=256):
    ids, sids, mask, labels = data
    logits = []
    model.eval()
    with torch.inference_mode():
        for start in range(0, len(labels), batch_size):
            args = [torch.as_tensor(x[start:start + batch_size], device=device) for x in (ids, sids, mask)]
            logits.extend(model(*args).float().cpu().numpy().tolist())
    return np.asarray(logits, dtype=np.float32), labels


def export_model(model, vocab, sentiment_ids, sentiment_scores, threshold, out_dir, max_length, d_ff):
    out_dir.mkdir(parents=True, exist_ok=True)
    state = model.state_dict()
    mapping = OrderedDict([
        ("embedding", "embedding.weight"),
        ("sentiment_embedding", "sentiment_embedding.weight"),
        ("position_embedding", "position_embedding.weight"),
        ("ln1_weight", "ln1.weight"), ("ln1_bias", "ln1.bias"),
        ("q_weight", "q.weight"), ("q_bias", "q.bias"),
        ("k_weight", "k.weight"), ("k_bias", "k.bias"),
        ("v_weight", "v.weight"), ("v_bias", "v.bias"),
        ("o_weight", "o.weight"), ("o_bias", "o.bias"),
        ("ln2_weight", "ln2.weight"), ("ln2_bias", "ln2.bias"),
        ("ff1_weight", "ff1.weight"), ("ff1_bias", "ff1.bias"),
        ("ff2_weight", "ff2.weight"), ("ff2_bias", "ff2.bias"),
        ("head_weight", "head.weight"), ("head_bias", "head.bias"),
    ])
    chunks, tensor_specs, offset = [], {}, 0
    for export_name, state_name in mapping.items():
        array = state[state_name].detach().float().cpu().contiguous().numpy()
        flat = array.reshape(-1)
        tensor_specs[export_name] = {"offset": offset, "size": int(flat.size), "shape": list(array.shape)}
        chunks.append(flat)
        offset += int(flat.size)
    packed = np.concatenate(chunks).astype("<f4", copy=False)
    packed.tofile(out_dir / "weights.bin")
    (out_dir / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    meta = {
        "format_version": VERSION,
        "task": "english_coherent_text_vs_synthetic_noise",
        "vocab_size": len(vocab), "max_length": max_length,
        "d_model": model.d_model, "n_heads": model.n_heads, "d_ff": d_ff,
        "layer_norm_eps": 1e-5, "cls_id": 2, "unk_id": 1, "threshold": float(threshold),
        "sentiment_ids": sentiment_ids, "sentiment_scores": sentiment_scores,
        "tensors": tensor_specs, "weight_count": int(offset),
        "threshold_goal_real_pass": 0.98,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--text", action="append", type=Path, default=[], help="Local English .txt corpus; repeat to add files. Skips automatic downloads when supplied.")
    parser.add_argument("--out", type=Path, default=Path("model"), help="Output model folder (default: ./model)")
    parser.add_argument("--cache", type=Path, default=Path(".training_cache"), help="Folder for downloaded text sources")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--max-spans", type=int, default=30000)
    parser.add_argument("--max-length", type=int, default=DEFAULT_MAX_LENGTH)
    parser.add_argument("--vocab-size", type=int, default=DEFAULT_VOCAB_SIZE)
    parser.add_argument("--seed", type=int, default=4317)
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is unavailable to this PyTorch install. Check torch.cuda.is_available() and your NVIDIA driver; this script does not install PyTorch.")
    device = torch.device("cuda")
    print(f"Training on {torch.cuda.get_device_name(0)} with the existing PyTorch install.")
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)

    sources = read_sources(args.text, args.cache)
    train_pos, val_pos, test_pos = make_splits(sources, args.seed)
    train_pos, val_pos, test_pos = [x[:args.max_spans] for x in (train_pos, val_pos, test_pos)]
    vocab = build_vocab(train_pos, args.vocab_size)
    word_to_id = {word: i for i, word in enumerate(vocab)}
    sentiment_ids = [sentiment_category(word) for word in vocab]
    sentiment_scores = [sentiment_score(word) for word in vocab]
    bank = [word for word in vocab[3:] if word.isalpha() and len(word) > 2]
    if len(bank) < 100:
        raise RuntimeError("The text corpus yielded too few distinct words. Supply more text with --text.")

    train_examples = make_examples(train_pos, bank, args.seed)
    validation_examples = make_examples(val_pos, bank, args.seed + 1, per_positive=2)
    test_examples = make_examples(test_pos, bank, args.seed + 2, per_positive=2)
    train_data = encode_examples(train_examples, word_to_id, sentiment_ids, args.max_length)
    val_data = encode_examples(validation_examples, word_to_id, sentiment_ids, args.max_length)
    test_data = encode_examples(test_examples, word_to_id, sentiment_ids, args.max_length)

    train_tensors = TensorDataset(*(torch.from_numpy(x) for x in train_data))
    loader = DataLoader(train_tensors, batch_size=args.batch_size, shuffle=True, pin_memory=True)
    model = TinyGuard(len(vocab), args.max_length).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=0.01)
    best_auc = -1.0
    best_state = None

    for epoch in range(1, args.epochs + 1):
        model.train()
        losses = []
        for batch in loader:
            ids, sids, mask, labels = [tensor.to(device, non_blocking=True) for tensor in batch]
            optimizer.zero_grad(set_to_none=True)
            logits = model(ids, sids, mask)
            loss = F.binary_cross_entropy_with_logits(logits, labels)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            losses.append(float(loss.detach().item()))
        val_logits, val_labels = predict(model, val_data, device)
        val_probs = 1 / (1 + np.exp(-np.clip(val_logits, -30, 30)))
        auc = auc_score(val_labels, val_probs)
        print(f"epoch {epoch}/{args.epochs} loss={np.mean(losses):.4f} validation_auc={auc:.4f}")
        if auc > best_auc:
            best_auc = auc
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}

    if best_state is None:
        raise RuntimeError("Training did not produce a checkpoint.")
    model.load_state_dict(best_state)
    val_logits, val_labels = predict(model, val_data, device)
    val_probs = 1 / (1 + np.exp(-np.clip(val_logits, -30, 30)))
    real_probs = np.sort(val_probs[val_labels == 1])
    # Pick the validation positive 2nd percentile, targeting 98% acceptance of
    # fluent samples. The held-out results below expose the junk trade-off.
    q_index = max(0, min(len(real_probs) - 1, int(.02 * len(real_probs))))
    threshold = float(real_probs[q_index])

    test_logits, test_labels = predict(model, test_data, device)
    test_probs = 1 / (1 + np.exp(-np.clip(test_logits, -30, 30)))
    real_pass = float(np.mean(test_probs[test_labels == 1] >= threshold))
    junk_caught = float(np.mean(test_probs[test_labels == 0] < threshold))
    auc = auc_score(test_labels, test_probs)
    print(f"heldout_auc={auc:.4f} real_pass_at_threshold={real_pass:.3f} junk_caught_at_threshold={junk_caught:.3f} threshold={threshold:.6f}")
    print("Synthetic junk results are a sanity check, not proof that the model can recognize sincerity.")
    export_model(model, vocab, sentiment_ids, sentiment_scores, threshold, args.out, args.max_length, DEFAULT_D_FF)
    print(f"Exported meta.json, vocab.json, weights.bin to: {args.out.resolve()}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Training interrupted; no new export was completed.", file=sys.stderr)
        raise
