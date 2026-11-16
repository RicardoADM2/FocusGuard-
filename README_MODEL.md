# Train the local FocusGuard answer model

The model screens the five hard-block removal answers for English text that resembles connected writing rather than generated keysmash, shuffled words, repeated phrases, or random word salad. It is a friction aid, not a sincerity detector. Sentiment categories enter through a small learned embedding; positive, negative, and neutral answers can all pass.

The extension runs inference locally in its Manifest V3 service worker. It does not send answers to a server. The background checks the scores before it starts the five-minute removal wait, so changing the page's JavaScript does not bypass the score gate.

## Train on the RTX 4050

Open a terminal in the extension folder and run the Python interpreter where your CUDA-enabled PyTorch is already installed:

```powershell
python train_guard.py
```

The script checks for CUDA and reports the selected GPU. It does not install or download PyTorch. If you want to supply your own English text corpus, use one or more `.txt` files:

```powershell
python train_guard.py --text .\my_english_text.txt
```

Without `--text`, it downloads two small public-domain English books into `.training_cache` using Python's standard library. The script builds training, validation, and held-out splits, generates synthetic junk examples, trains a small one-block transformer, selects a threshold targeting 98% validation acceptance of fluent samples, reports held-out AUC and pass/catch rates, and exports:

- `model\meta.json`
- `model\vocab.json`
- `model\weights.bin`

Keep these three generated files from the same run together. The extension's `model\guard.js` is the matching inference runtime and must remain in that folder. The settings are small (64-dimensional, one transformer block); the 4050 is used only for local training, while browser inference runs on CPU.

## Update the unpacked extension

If you trained from the extension folder itself, the model files are already in the right place. Otherwise, copy the three generated files into that extension's `model` folder alongside `guard.js`. In the browser's extension manager, reload FocusGuard and reload any open FocusGuard pages.

Hard blocks continue to block sites before the model is trained. Removing a hard block stays unavailable until valid `meta.json`, `vocab.json`, and `weights.bin` files are installed. The UI reports this state instead of silently accepting unchecked answers.

## Limits and tuning

This compact model is English-only by default. Its positive examples are prose from the training corpus, while negative examples are synthetic corruptions. A high held-out score on these generated examples does not establish that the model knows whether a reflection is honest, specific, or sincere. Review the printed metrics and add representative, consented examples to your own corpus if you need better coverage. Avoid using private journal text without considering where that text will be stored; training is local.

`--epochs`, `--batch-size`, `--max-spans`, `--max-length`, `--vocab-size`, and `--out` can be adjusted. Lower batch size if CUDA runs out of memory. The default output path is `model`.
