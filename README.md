# 🏰 ComfyCrawler

> **A nostalgic Windows 95 style 3D dungeon crawler powered by ComfyUI, FLUX.1 [schnell], MiniMax H3, and RTX Video Super Resolution.**

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**ComfyCrawler** turns natural language descriptions into interactive, walkable 3D escape rooms with the authentic Windows 95 3D Maze Screensaver aesthetic.

---

## ✨ Features

* 🧙‍♂️ **Prompt-Driven Dungeons**: Type any visual theme (*e.g., "Windows 95", "Cyber Neon", "Mossy Stone", "Candy Cane"*) and watch the world generate before your eyes with automated retro prompt enhancement.
* ⚡ **Triple Engine Modes**:
  * **`v3 FLUX.1 [schnell]` (Recommended)**: Powered by Google's T5-XXL language model + 12B parameter Flow Matching DiT. Generates a matching 3-surface texture set (**Walls, Ceiling, and Floor**) in a single pass with snappy **350ms** retro movement and zero hallucinations.
  * **`v2 texture`**: Synthesizes high-res material textures with MiniMax H3 in a 3D raycaster.
  * **`v1 video` (Pre-Rendered FMV Clips)**: Generates 8 frame-chained 1.5s AI video clips with native reverse playback using MiniMax H3 diffusion.
* 🔊 **Generated Sound Effects** (`v6`): Stable Audio 3 Small-SFX writes the game's foley from the same typed styles the art comes from - the footstep matches the floor, the swing matches the weapon, and the death cries match the hero and the foe. Eight one-shots per dungeon, with a procedural Web Audio bank standing in for anything that fails.
* 🏆 **A Victory Song Per Style**: five different win themes share the victory window - an orchestral march, retro synthwave, and three more variations picked from a wider audition. Which one plays is decided by the dungeon style you typed, not by chance: every *forest* run you ever play ends on the same song, every *ocean* run ends on a different one, and capitalisation, spacing and punctuation don't count - so the ending music becomes part of what a style *is*, the way its walls are.
* 🎬 **Ending Cutscene** (`v6`, off by default): switch on **Ending Video** in Options and MiniMax H3 films the hero landing the final blow on the boss, the stairs out glowing at the end of the corridor, and a victory cheer. The run's own hero sprite, HUD portrait, boss and textures go in as reference pictures and its battle music as a reference track for the score. It plays the moment the boss's health runs out and holds its last frame under the victory window. It is filmed at 512×384 on the loading screen. Every run in **History** has a movie button too: it plays the ending of a dungeon you have beaten, and films one for a dungeon that never got one.
* 🖥️ **Authentic Windows 95 UI**: Classic beveled grey window styling, dynamic 3-space minimap (`[ 1 ] ⟷ [ 2 ] ⟷ [ 3 ]`), D-pad controls, and real-time progress HUD.
* 🚀 **Hardware Accelerated**: RTX Video Super Resolution (2x Ultra) + SageAttention integration for ultra-fast generation.

---

## 🎮 Controls

| Action | Keyboard | D-Pad Button |
| :--- | :--- | :--- |
| **Move Forward** | <kbd>W</kbd> or <kbd>▲</kbd> | ▲ Button |
| **Move Backward** | <kbd>S</kbd> or <kbd>▼</kbd> | ▼ Button |
| **Rotate Left 90°** | <kbd>A</kbd> or <kbd>◀</kbd> | ◀ Button |
| **Rotate Right 90°** | <kbd>D</kbd> or <kbd>▶</kbd> | ▶ Button |

---

## 🛠️ Quickstart

### Prerequisites
1. [ComfyUI](https://github.com/comfyanonymous/ComfyUI) 0.34.2+ running locally on port `8188` with `flux1-schnell-fp8.safetensors` in `models/checkpoints/`.
2. Python 3.10+ installed.
3. For `v6` sound effects, from [Comfy-Org/stable-audio-3](https://huggingface.co/Comfy-Org/stable-audio-3):
   * `checkpoints/stable_audio_3_small_sfx.safetensors` (2.3 GB) -> `models/checkpoints/`
   * `text_encoders/t5gemma_b_b_ul2.safetensors` (1.2 GB) -> `models/text_encoders/`

   Optional: without them a v6 dungeon still generates and plays, using procedural sounds instead.
4. For the `v6` ending cutscene, from [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3):
   * `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` (21 GB) -> `models/diffusion_models/`
   * `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (15.7 GB) -> `models/text_encoders/`
   * `vae/minimax_h3_video_vae_fp16.safetensors` and `vae/minimax_h3_audio_vae_fp32.safetensors` -> `models/vae/`

   Optional: only needed with Ending Video turned on. [KJNodes](https://github.com/kijai/ComfyUI-KJNodes) with SageAttention installed is used automatically when present.

### Installation
```bash
git clone https://github.com/sorryaboutyourcats/ComfyCrawler.git
cd ComfyCrawler
pip install -r requirements.txt
```

### Launch Server
```bash
python server.py
```
Open `http://127.0.0.1:5555` in any modern web browser to play!

---

## 📜 License
MIT License.
