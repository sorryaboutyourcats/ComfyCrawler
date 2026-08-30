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
1. [ComfyUI](https://github.com/comfyanonymous/ComfyUI) running locally on port `8188` with `flux1-schnell-fp8.safetensors` in `models/checkpoints/`.
2. Python 3.10+ installed.

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
