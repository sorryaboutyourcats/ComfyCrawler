"""
ComfyCrawler - Server & Engine
A retro Windows 95 style 3D dungeon escape game powered by ComfyUI, FLUX.1 [schnell], and MiniMax H3.
Supports:
- v3 flux (Default): FLUX.1 [schnell] 4-step DiT with T5-XXL generating all 3 surfaces (Wall, Ceiling, Floor) + level 3D engine.
- v2 texture: MiniMax H3 material texture synthesizer.
- v1 video: 8 frame-chained 1.5s AI video clips with native reverse playback.
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import http.server
import socketserver
import urllib.request
import urllib.parse
import json
import os
import shutil
import time
import base64
import random
import threading
import subprocess
import imageio_ffmpeg

PORT = 5555
COMFY_URL = "http://127.0.0.1:8188"
COMFY_INPUT_DIR = r"C:\Users\sorryaboutyourcats\AppData\Local\Comfy-Desktop\ComfyUI-Shared\input"
COMFY_OUTPUT_DIR = r"C:\Users\sorryaboutyourcats\AppData\Local\Comfy-Desktop\ComfyUI-Shared\output"
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
SESSIONS_DIR = os.path.join(PROJECT_DIR, "dungeon_sessions")

os.makedirs(SESSIONS_DIR, exist_ok=True)
os.makedirs(COMFY_INPUT_DIR, exist_ok=True)

gen_progress = {
    "is_generating": False,
    "current_step": 0,
    "total_steps": 2,
    "status_message": "Idle",
    "percent": 0,
    "completed_bundle": None,
    "error": None
}

def get_surface_prompts(wall_style):
    """Automatically enhance and stylize short user inputs into vibrant, retro 90s textures for all 3 surfaces."""
    ui = wall_style.strip().lower()
    
    if any(k in ui for k in ['win95', 'windows 95', 'windows', 'win 95', 'brick', '95', 'retro brick']):
        wall_p = "Authentic Windows 95 3D maze screensaver wall texture, large chunky bold crimson red bricks with thick stark white mortar lines, clean repeating seamless 2D pattern, vibrant high saturation retro 90s low-poly CGI, flat straight-on view."
        ceil_p = "Authentic Windows 95 acoustic drop ceiling tile texture, speckled mineral fiber surface with grey metal grid panel seams, flat straight-on view, retro 90s computer graphics."
        floor_p = "Authentic Windows 95 golden amber woodgrain parquet floor texture, warm rich wood planks with wood grain striations and seams, flat straight-on view, retro 90s CGI."
    
    elif any(k in ui for k in ['cyber', 'neon', 'cyberpunk', 'matrix', 'sci-fi', 'circuits']):
        wall_p = "Retro 90s CGI sci-fi texture of glowing cyan and electric purple neon circuit panels, dark metal cyber grid, vibrant high saturation, clean repeating seamless 2D surface pattern, bold contrast, flat straight-on orthographic view."
        ceil_p = "Retro 90s CGI sci-fi ceiling texture, dark steel metal plates with glowing neon conduit cables and vent grates, flat straight-on view, vibrant saturated cyan accents."
        floor_p = "Retro 90s CGI cybernetic floor texture, dark hexagonal metal grid tiles with pulsing illuminated neon seam lines, flat straight-on view."
    
    elif any(k in ui for k in ['moss', 'stone', 'castle', 'dungeon', 'ancient']):
        wall_p = "Retro 90s CGI dungeon wall texture, weathered grey castle stone blocks with vibrant lush green moss patches in cracks, clean repeating seamless 2D pattern, high saturation, sharp lighting, flat straight-on orthographic view."
        ceil_p = "Retro 90s CGI dungeon ceiling texture, rough ancient dark stone vault slabs with green moss patches, flat straight-on view."
        floor_p = "Retro 90s CGI dungeon floor texture, uneven weathered grey flagstone cobblestones with dirt seams, flat straight-on view."
    
    elif any(k in ui for k in ['candy', 'gingerbread', 'sweet', 'peppermint', 'cake']):
        wall_p = "Retro 90s CGI candy wall texture, vibrant red and white peppermint candy cane stripes and gingerbread cookie pattern with white royal icing, bold saturated colors, seamless repeating 2D surface pattern, flat straight-on view."
        ceil_p = "Retro 90s CGI candy ceiling texture, fluffy pastel pink cotton candy and marshmallow cloud pattern with rainbow sprinkles, flat straight-on view."
        floor_p = "Retro 90s CGI candy floor texture, rich chocolate cookie crumb tiles with glazed caramel syrup seams, flat straight-on view."
    
    else:
        wall_p = f"Retro 90s CGI gaming texture of {wall_style} walls, vibrant bold saturated colors, high-contrast clean repeating seamless 2D surface pattern, authentic 1995 computer graphics aesthetic, flat straight-on orthographic view."
        ceil_p = f"Retro 90s CGI gaming ceiling texture matching {wall_style}, clean repeating seamless 2D surface pattern, flat straight-on view."
        floor_p = f"Retro 90s CGI gaming floor ground texture matching {wall_style}, clean repeating seamless 2D surface pattern, flat straight-on view."
    
    return wall_p, ceil_p, floor_p


def generate_flux_trio_textures(wall_style):
    """Generate all 3 textures (Wall, Ceiling, Floor) in a single unified FLUX.1 pass."""
    prefix_w = f"trio_w_{int(time.time()*1000)}"
    prefix_c = f"trio_c_{int(time.time()*1000)}"
    prefix_f = f"trio_f_{int(time.time()*1000)}"
    
    wall_p, ceil_p, floor_p = get_surface_prompts(wall_style)
    
    prompt_payload = {
        "1": {"inputs": {"ckpt_name": "flux1-schnell-fp8.safetensors"}, "class_type": "CheckpointLoaderSimple"},
        "neg": {"inputs": {"text": "", "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        
        # Wall
        "w_lat": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "w_pos": {"inputs": {"text": wall_p, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        "w_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["w_pos", 0], "negative": ["neg", 0], "latent_image": ["w_lat", 0]}, "class_type": "KSampler"},
        "w_dec": {"inputs": {"samples": ["w_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
        "w_save": {"inputs": {"filename_prefix": prefix_w, "images": ["w_dec", 0]}, "class_type": "SaveImage"},
        
        # Ceiling
        "c_lat": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "c_pos": {"inputs": {"text": ceil_p, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        "c_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["c_pos", 0], "negative": ["neg", 0], "latent_image": ["c_lat", 0]}, "class_type": "KSampler"},
        "c_dec": {"inputs": {"samples": ["c_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
        "c_save": {"inputs": {"filename_prefix": prefix_c, "images": ["c_dec", 0]}, "class_type": "SaveImage"},
        
        # Floor
        "f_lat": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "f_pos": {"inputs": {"text": floor_p, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        "f_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["f_pos", 0], "negative": ["neg", 0], "latent_image": ["f_lat", 0]}, "class_type": "KSampler"},
        "f_dec": {"inputs": {"samples": ["f_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
        "f_save": {"inputs": {"filename_prefix": prefix_f, "images": ["f_dec", 0]}, "class_type": "SaveImage"}
    }

    data = json.dumps({"prompt": prompt_payload}).encode("utf-8")
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        res_json = json.loads(resp.read().decode("utf-8"))
        prompt_id = res_json["prompt_id"]

    start_time = time.time()
    while time.time() - start_time < 90:
        time.sleep(0.1)
        hist_req = urllib.request.Request(f"{COMFY_URL}/history/{prompt_id}")
        with urllib.request.urlopen(hist_req) as h_resp:
            hist_data = json.loads(h_resp.read().decode("utf-8"))
            if prompt_id in hist_data:
                outputs = hist_data[prompt_id].get("outputs", {})
                if "w_save" in outputs and "c_save" in outputs and "f_save" in outputs:
                    w_img = outputs["w_save"]["images"][0]["filename"]
                    c_img = outputs["c_save"]["images"][0]["filename"]
                    f_img = outputs["f_save"]["images"][0]["filename"]
                    
                    w_sub = outputs["w_save"]["images"][0].get("subfolder", "")
                    c_sub = outputs["c_save"]["images"][0].get("subfolder", "")
                    f_sub = outputs["f_save"]["images"][0].get("subfolder", "")
                    
                    w_path = os.path.join(COMFY_OUTPUT_DIR, w_sub, w_img)
                    c_path = os.path.join(COMFY_OUTPUT_DIR, c_sub, c_img)
                    f_path = os.path.join(COMFY_OUTPUT_DIR, f_sub, f_img)
                    
                    return w_path, c_path, f_path
                    
    raise TimeoutError("FLUX.1 Trio generation timed out.")


def run_batch_v3_flux(wall_style):
    """v3 FLUX.1 [schnell] mode: 4-step DiT generating Wall, Ceiling, and Floor textures."""
    global gen_progress
    gen_progress["is_generating"] = True
    gen_progress["completed_bundle"] = None
    gen_progress["error"] = None
    gen_progress["current_step"] = 0
    gen_progress["total_steps"] = 2

    try:
        gen_progress["current_step"] = 1
        gen_progress["status_message"] = "Synthesizing Wall, Ceiling & Floor with FLUX.1 [schnell]..."
        gen_progress["percent"] = 50
        print(f"[FLUX.1] Generating full 3-surface textures for '{wall_style}'")

        w_path, c_path, f_path = generate_flux_trio_textures(wall_style)

        gen_progress["current_step"] = 2
        gen_progress["status_message"] = "Mapping 3D Dungeon Environment..."
        gen_progress["percent"] = 90

        with open(w_path, "rb") as tf:
            w_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        with open(c_path, "rb") as tf:
            c_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        with open(f_path, "rb") as tf:
            f_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"

        gen_progress["percent"] = 100
        gen_progress["status_message"] = "FLUX.1 3D Dungeon Ready!"
        gen_progress["completed_bundle"] = {
            "mode": "v3_flux",
            "wall_style": wall_style,
            "wall_texture": w_b64,
            "ceiling_texture": c_b64,
            "floor_texture": f_b64
        }
        print("[FLUX.1] All 3 textures complete and packaged!")

    except Exception as e:
        print(f"[FLUX.1 Error] {e}")
        gen_progress["error"] = str(e)
    finally:
        gen_progress["is_generating"] = False


def generate_video_comfy(prompt_text, initial_image_path=None, duration=1.5, steps=8, fps=16):
    prefix = f"crawler_{int(time.time()*1000)}"
    prompt_payload = {
        "105:6": {"inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}, "class_type": "UNETLoader"},
        "105:119": {"inputs": {"sage_attention": "sageattn_qk_int8_pv_fp16_cuda", "allow_compile": False, "model": ["105:6", 0]}, "class_type": "PathchSageAttentionKJ"},
        "105:13": {"inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}, "class_type": "CLIPLoader"},
        "105:11": {"inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}, "class_type": "VAELoader"},
        "105:24": {"inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}, "class_type": "VAELoader"},
        "105:15": {"inputs": {"noise_seed": random.randint(1, 1000000000000)}, "class_type": "RandomNoise"},
        "105:17": {"inputs": {"sampler_name": "res_multistep"}, "class_type": "KSamplerSelect"},
        "105:9": {"inputs": {"scheduler": "simple", "steps": steps, "denoise": 1.0, "model": ["105:6", 0]}, "class_type": "BasicScheduler"},
        "105:111": {"inputs": {"value": duration}, "class_type": "PrimitiveFloat"},
        "105:107": {"inputs": {"expression": f"max(5, round(a * {fps})) + (5 - (max(5, round(a * {fps})) % 17)) % 17", "values.a": ["105:111", 0]}, "class_type": "ComfyMathExpression"},
        "115": {"inputs": {"aspect_ratio": "4:3 (Standard)", "megapixels": 0.1, "multiple": 32}, "class_type": "ResolutionSelector"},
        "105:104": {"inputs": {"prompt": prompt_text, "clip": ["105:13", 0], "vae": ["105:11", 0], "width": ["115", 0], "height": ["115", 1], "length": ["105:107", 1]}, "class_type": "MiniMaxH3ImageToVideo"},
        "105:16": {"inputs": {"model": ["105:119", 0], "conditioning": ["105:104", 0]}, "class_type": "BasicGuider"},
        "105:14": {"inputs": {"noise": ["105:15", 0], "guider": ["105:16", 0], "sampler": ["105:17", 0], "sigmas": ["105:9", 0], "latent_image": ["105:104", 1]}, "class_type": "SamplerCustomAdvanced"},
        "105:10": {"inputs": {"samples": ["105:14", 0], "vae": ["105:11", 0]}, "class_type": "VAEDecode"},
        "105:23": {"inputs": {"samples": ["105:14", 0], "vae": ["105:24", 0]}, "class_type": "VAEDecodeAudio"},
        "105:120": {"inputs": {"images": ["105:10", 0], "resize_type": "scale by multiplier", "resize_type.scale": 2.0, "quality": "ULTRA"}, "class_type": "RTXVideoSuperResolution"},
        "105:91": {"inputs": {"fps": float(fps), "bit_depth": 8, "color_space": "sRGB", "images": ["105:120", 0], "audio": ["105:23", 0]}, "class_type": "CreateVideo"},
        "92": {"inputs": {"filename_prefix": f"video/{prefix}", "format": "auto", "format.codec": "auto", "video": ["105:91", 0]}, "class_type": "SaveVideo"}
    }
    if initial_image_path and os.path.exists(initial_image_path):
        input_img_name = f"anchor_{int(time.time()*1000)}.png"
        shutil.copy2(initial_image_path, os.path.join(COMFY_INPUT_DIR, input_img_name))
        prompt_payload["load_img"] = {"inputs": {"image": input_img_name}, "class_type": "LoadImage"}
        prompt_payload["105:104"]["inputs"]["first_frame"] = ["load_img", 0]

    data = json.dumps({"prompt": prompt_payload}).encode("utf-8")
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        res_json = json.loads(resp.read().decode("utf-8"))
        prompt_id = res_json["prompt_id"]

    start_time = time.time()
    while time.time() - start_time < 300:
        time.sleep(0.6)
        hist_req = urllib.request.Request(f"{COMFY_URL}/history/{prompt_id}")
        with urllib.request.urlopen(hist_req) as h_resp:
            hist_data = json.loads(h_resp.read().decode("utf-8"))
            if prompt_id in hist_data:
                outputs = hist_data[prompt_id].get("outputs", {})
                if "92" in outputs:
                    imgs = outputs["92"].get("images", [])
                    if imgs:
                        fname = imgs[0]["filename"]
                        subf = imgs[0].get("subfolder", "video")
                        full_path = os.path.join(COMFY_OUTPUT_DIR, subf, fname)
                        if os.path.exists(full_path):
                            return full_path
    raise TimeoutError("ComfyUI generation timed out.")


def run_batch_v2_texture(wall_style):
    global gen_progress
    gen_progress["is_generating"] = True
    gen_progress["completed_bundle"] = None
    gen_progress["error"] = None
    gen_progress["current_step"] = 0
    gen_progress["total_steps"] = 2

    session_id = f"v2_{int(time.time())}"
    session_dir = os.path.join(SESSIONS_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

    try:
        gen_progress["current_step"] = 1
        gen_progress["status_message"] = "Synthesizing Material Texture with MiniMax H3..."
        gen_progress["percent"] = 40

        prompt = f"Windows 95 3D maze screensaver retro aesthetic, close-up texture view of {wall_style}, clean repeating pattern, textured stone ceiling above, yellow carpet floor below, sharp retro 90s CGI lighting, level perspective."
        video_path = generate_video_comfy(prompt_text=prompt, initial_image_path=None, duration=1.0, steps=8, fps=16)
        
        target_video = os.path.join(session_dir, "style_material.mp4")
        shutil.copy2(video_path, target_video)

        gen_progress["current_step"] = 2
        gen_progress["status_message"] = "Extracting High-Res Texture Frames..."
        gen_progress["percent"] = 80

        tex_png = os.path.join(session_dir, "wall_texture.png")
        subprocess.run([ffmpeg_exe, "-y", "-i", target_video, "-vframes", "1", tex_png], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        tex_b64 = ""
        if os.path.exists(tex_png):
            with open(tex_png, "rb") as tf:
                tex_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"

        gen_progress["percent"] = 100
        gen_progress["status_message"] = "v2 Texture Ready!"
        gen_progress["completed_bundle"] = {
            "mode": "v2_texture",
            "wall_style": wall_style,
            "wall_texture": tex_b64
        }

    except Exception as e:
        print(f"[v2 Error] {e}")
        gen_progress["error"] = str(e)
    finally:
        gen_progress["is_generating"] = False


def extract_frame(video_path, output_png_path, is_end_frame=True):
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    if is_end_frame:
        subprocess.run([ffmpeg_exe, "-y", "-sseof", "-0.08", "-i", video_path, "-vframes", "1", output_png_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        subprocess.run([ffmpeg_exe, "-y", "-i", video_path, "-vframes", "1", output_png_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def create_reverse_video(input_video_path, output_video_path):
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([ffmpeg_exe, "-y", "-i", input_video_path, "-vf", "reverse", output_video_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def run_batch_v1_video(wall_style):
    global gen_progress
    gen_progress["is_generating"] = True
    gen_progress["completed_bundle"] = None
    gen_progress["error"] = None
    gen_progress["current_step"] = 0
    gen_progress["total_steps"] = 8

    session_id = f"v1_{int(time.time())}"
    session_dir = os.path.join(SESSIONS_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)

    base_style = f"Windows 95 3D maze screensaver retro aesthetic, {wall_style}, textured ceiling, matching floor, 90s low-poly CGI computer graphics look, sharp lighting, steady camera."

    clips_data = {}
    initial_image_b64 = ""

    frame_spot1_east = os.path.join(session_dir, "frame_spot1_east.png")
    frame_spot2_east = os.path.join(session_dir, "frame_spot2_east.png")
    frame_spot3_deadend = os.path.join(session_dir, "frame_spot3_deadend.png")
    frame_wall_left = os.path.join(session_dir, "frame_wall_left.png")
    frame_wall_right = os.path.join(session_dir, "frame_wall_right.png")

    try:
        gen_progress["current_step"] = 1
        gen_progress["status_message"] = "Clip 1/8: Forward Spot 1 -> Spot 2..."
        gen_progress["percent"] = 12
        p1 = f"First-person POV camera moving forward smoothly down the center of the straight hallway from spot 1 to spot 2. {base_style}"
        v1 = generate_video_comfy(prompt_text=p1, initial_image_path=None, duration=1.5, steps=8, fps=16)
        v1_dst = os.path.join(session_dir, "1_to_2_east.mp4")
        shutil.copy2(v1, v1_dst)

        extract_frame(v1_dst, frame_spot1_east, is_end_frame=False)
        extract_frame(v1_dst, frame_spot2_east, is_end_frame=True)

        if os.path.exists(frame_spot1_east):
            with open(frame_spot1_east, "rb") as sf:
                initial_image_b64 = f"data:image/png;base64,{base64.b64encode(sf.read()).decode('utf-8')}"

        v1_rev = os.path.join(session_dir, "1_to_2_east_reverse.mp4")
        create_reverse_video(v1_dst, v1_rev)

        with open(v1_dst, "rb") as vf:
            clips_data["1_to_2_east"] = f"data:video/mp4;base64,{base64.b64encode(vf.read()).decode('utf-8')}"
        with open(v1_rev, "rb") as vf:
            clips_data["1_to_2_east_reverse"] = f"data:video/mp4;base64,{base64.b64encode(vf.read()).decode('utf-8')}"

        gen_progress["current_step"] = 2
        gen_progress["status_message"] = "Clip 2/8: Forward Spot 2 -> Spot 3..."
        gen_progress["percent"] = 25
        p2 = f"First-person POV camera moving forward down the hallway from spot 2 and stopping directly in front of the flat solid dead-end wall at spot 3. {base_style}"
        v2 = generate_video_comfy(prompt_text=p2, initial_image_path=frame_spot2_east, duration=1.5, steps=8, fps=16)
        v2_dst = os.path.join(session_dir, "2_to_3_east.mp4")
        shutil.copy2(v2, v2_dst)
        extract_frame(v2_dst, frame_spot3_deadend, is_end_frame=True)

        v2_rev = os.path.join(session_dir, "2_to_3_east_reverse.mp4")
        create_reverse_video(v2_dst, v2_rev)

        with open(v2_dst, "rb") as vf:
            clips_data["2_to_3_east"] = f"data:video/mp4;base64,{base64.b64encode(vf.read()).decode('utf-8')}"
        with open(v2_rev, "rb") as vf:
            clips_data["2_to_3_east_reverse"] = f"data:video/mp4;base64,{base64.b64encode(vf.read()).decode('utf-8')}"

        gen_progress["current_step"] = 3
        gen_progress["status_message"] = "Clip 3/8: 90° Turn LEFT to Side Wall..."
        gen_progress["percent"] = 38
        p3 = f"First-person POV camera smoothly rotating 90 degrees to the left in place to face flat directly against the solid close side wall. {base_style}"
        v3 = generate_video_comfy(prompt_text=p3, initial_image_path=frame_spot2_east, duration=1.5, steps=8, fps=16)
        v3_dst = os.path.join(session_dir, "turn_corridor_to_wall_left.mp4")
        shutil.copy2(v3, v3_dst)
        extract_frame(v3_dst, frame_wall_left, is_end_frame=True)

        with open(v3_dst, "rb") as vf:
            clips_data["turn_corridor_to_wall_left"] = f"data:video/mp4;base64,{base64.b64encode(vf.read()).decode('utf-8')}"

        gen_progress["current_step"] = 4
        gen_progress["status_message"] = "Clip 4/8: 90° Turn RIGHT to Side Wall..."
        gen_progress["percent"] = 50
        p4 = f"First-person POV camera smoothly rotating 90 degrees to the right in place to face flat directly against the solid close side wall. {base_style}"
        v4 = generate_video_comfy(prompt_text=p4, initial_image_path=frame_spot2_east, duration=1.5, steps=8, fps=16)
        v4_dst = os.path.join(session_dir, "turn_corridor_to_wall_right.mp4")
        shutil.copy2(v4, v4_dst)
        extract_frame(v4_dst, frame_wall_right, is_end_frame=True)

        with open(v4_dst, "rb") as vf:
            clips_data["turn_corridor_to_wall_right"] = f"data:video/mp4;base64,{base64.b64encode(vf.read()).decode('utf-8')}"

        gen_progress["current_step"] = 5
        gen_progress["status_message"] = "Clip 5/8: 90° Turn LEFT to Corridor..."
        gen_progress["percent"] = 62
        p5 = f"First-person POV camera smoothly rotating 90 degrees to the left in place to reveal the open straight corridor. {base_style}"
        v5 = generate_video_comfy(prompt_text=p5, initial_image_path=frame_wall_right, duration=1.5, steps=8, fps=16)
        v5_dst = os.path.join(session_dir, "turn_wall_to_corridor_left.mp4")
        shutil.copy2(v5, v5_dst)

        with open(v5_dst, "rb") as vf:
            clips_data["turn_wall_to_corridor_left"] = f"data:video/mp4;base64,{base64.b64encode(vf.read()).decode('utf-8')}"

        gen_progress["current_step"] = 6
        gen_progress["status_message"] = "Clip 6/8: 90° Turn RIGHT to Corridor..."
        gen_progress["percent"] = 75
        p6 = f"First-person POV camera smoothly rotating 90 degrees to the right in place to reveal the open straight corridor. {base_style}"
        v6 = generate_video_comfy(prompt_text=p6, initial_image_path=frame_wall_left, duration=1.5, steps=8, fps=16)
        v6_dst = os.path.join(session_dir, "turn_wall_to_corridor_right.mp4")
        shutil.copy2(v6, v6_dst)

        with open(v6_dst, "rb") as vf:
            clips_data["turn_wall_to_corridor_right"] = f"data:video/mp4;base64,{base64.b64encode(vf.read()).decode('utf-8')}"

        gen_progress["current_step"] = 7
        gen_progress["status_message"] = "Clip 7/8: 90° Corner Turn LEFT..."
        gen_progress["percent"] = 87
        p7 = f"First-person POV camera smoothly rotating 90 degrees to the left in a corner between two solid walls. {base_style}"
        v7 = generate_video_comfy(prompt_text=p7, initial_image_path=frame_wall_right, duration=1.5, steps=8, fps=16)
        v7_dst = os.path.join(session_dir, "turn_wall_to_wall_left.mp4")
        shutil.copy2(v7, v7_dst)

        with open(v7_dst, "rb") as vf:
            clips_data["turn_wall_to_wall_left"] = f"data:video/mp4;base64,{base64.b64encode(vf.read()).decode('utf-8')}"

        gen_progress["current_step"] = 8
        gen_progress["status_message"] = "Clip 8/8: 90° Corner Turn RIGHT..."
        gen_progress["percent"] = 97
        p8 = f"First-person POV camera smoothly rotating 90 degrees to the right in a corner between two solid walls. {base_style}"
        v8 = generate_video_comfy(prompt_text=p8, initial_image_path=frame_wall_left, duration=1.5, steps=8, fps=16)
        v8_dst = os.path.join(session_dir, "turn_wall_to_wall_right.mp4")
        shutil.copy2(v8, v8_dst)

        with open(v8_dst, "rb") as vf:
            clips_data["turn_wall_to_wall_right"] = f"data:video/mp4;base64,{base64.b64encode(vf.read()).decode('utf-8')}"

        gen_progress["percent"] = 100
        gen_progress["status_message"] = "v1 Video Generation Complete!"
        gen_progress["completed_bundle"] = {
            "mode": "v1_video",
            "wall_style": wall_style,
            "clips": clips_data,
            "initial_image": initial_image_b64
        }

    except Exception as e:
        print(f"[v1 Error] {e}")
        gen_progress["error"] = str(e)
    finally:
        gen_progress["is_generating"] = False


class DungeonHTTPRequestHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/progress":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(gen_progress, ensure_ascii=True).encode("utf-8"))
            return
        
        elif self.path == "/" or self.path == "/index.html":
            html_file = os.path.join(PROJECT_DIR, "index.html")
            if os.path.exists(html_file):
                with open(html_file, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/api/generate_dungeon":
            content_length = int(self.headers["Content-Length"])
            body = self.rfile.read(content_length).decode("utf-8")
            data = json.loads(body)
            wall_style = data.get("wall_style", "Windows 95")
            mode = data.get("mode", "v3_flux")

            if not gen_progress["is_generating"]:
                if mode == "v1_video":
                    t = threading.Thread(target=run_batch_v1_video, args=(wall_style,), daemon=True)
                elif mode == "v2_texture":
                    t = threading.Thread(target=run_batch_v2_texture, args=(wall_style,), daemon=True)
                else:
                    t = threading.Thread(target=run_batch_v3_flux, args=(wall_style,), daemon=True)
                t.start()

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "message": f"{mode} generation started"}, ensure_ascii=True).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def run_server():
    print(f"Starting ComfyCrawler Trio Server on http://127.0.0.1:{PORT}...")
    with socketserver.TCPServer(("", PORT), DungeonHTTPRequestHandler) as httpd:
        httpd.serve_forever()

if __name__ == "__main__":
    run_server()
