# FocusGuard

FocusGuard is a Manifest V3 Chromium extension for timed blocks and hard blocks. Timed blocks use a countdown before a temporary unlock. Hard blocks ignore the timed-block switch and require five written answers plus a five-minute wait before removal.

## Install

Load this folder as an unpacked extension from `chrome://extensions` (or the equivalent page in another Chromium browser). The popup is `pages/popup.html`; the blocked page and removal flow are in `pages/blocked.html` and `pages/blocked.js`.

## Answer-quality model

Hard-block removal uses a small English transformer to screen for scrambled or random text. Training and installation instructions are in [README_MODEL.md](README_MODEL.md). Run `python train_guard.py` in the folder with your existing CUDA-enabled PyTorch install. The answer text is evaluated locally in the extension. The model is only a writing-coherence gate; it cannot establish sincerity.

The background service worker enforces the model score before starting the removal wait. Until the three generated model files are installed, hard blocks remain active and the extension explains that the model is unavailable.
