"""
ComfyCrawler - Server & Engine
A retro Windows 95 style 3D dungeon escape game powered by ComfyUI, FLUX.1 [schnell], and MiniMax H3.
"""

from PIL import Image
import numpy as np
import sys
import re
import io
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


def make_seamless_4way(img_path, blend_pixels=12):
    """Clean narrow-rim blend for seamless dungeon tiling."""
    try:
        img = Image.open(img_path).convert("RGBA")
        w, h = img.size
        margin = 8
        img_cropped = img.crop((margin, margin, w - margin, h - margin)).resize((w, h), Image.Resampling.LANCZOS)
        arr = np.array(img_cropped).astype(np.float32)
        res = arr.copy()
        
        bw = min(blend_pixels, w // 4)
        bh = min(blend_pixels, h // 4)
        
        for x in range(bw):
            t = x / bw
            alpha = t * t * (3 - 2 * t)
            v_left = arr[:, x, :]
            v_right = arr[:, w - 1 - x, :]
            mid = 0.5 * (v_left + v_right)
            res[:, x, :] = v_left * alpha + mid * (1.0 - alpha)
            res[:, w - 1 - x, :] = v_right * alpha + mid * (1.0 - alpha)
            
        for y in range(bh):
            t = y / bh
            alpha = t * t * (3 - 2 * t)
            v_top = res[y, :, :]
            v_bot = res[h - 1 - y, :, :]
            mid = 0.5 * (v_top + v_bot)
            res[y, :, :] = v_top * alpha + mid * (1.0 - alpha)
            res[h - 1 - y, :, :] = v_bot * alpha + mid * (1.0 - alpha)
            
        res_img = Image.fromarray(np.clip(res, 0, 255).astype(np.uint8))
        res_img.save(img_path, format="PNG")
    except Exception as e:
        print(f"[Seamless Error] {e}")


def make_sprite_transparent(img_path):
    import numpy as np
    from PIL import Image
    try:
        img = Image.open(img_path).convert("RGBA")
        arr = np.array(img).astype(np.float32)
        
        corners = [arr[0:15, 0:15], arr[0:15, -15:], arr[-15:, 0:15], arr[-15:, -15:]]
        bg_color = np.mean([c.mean(axis=(0, 1))[:3] for c in corners], axis=0)
        
        diff = np.sqrt(np.sum((arr[:, :, :3] - bg_color) ** 2, axis=-1))
        alpha = np.clip((diff - 20) / 30, 0, 1) * 255.0
        
        white_mask = np.sum(arr[:, :, :3], axis=-1) > 700
        alpha[white_mask] = 0
        arr[:, :, 3] = alpha
        
        # Crop to tightest bounding box
        non_zero = np.where(arr[:, :, 3] > 20)
        if len(non_zero[0]) > 0:
            y1, y2 = non_zero[0].min(), non_zero[0].max()
            x1, x2 = non_zero[1].min(), non_zero[1].max()
            cropped = arr[y1:y2+1, x1:x2+1]
        else:
            cropped = arr
            
        out_img = Image.fromarray(np.clip(cropped, 0, 255).astype(np.uint8))
        out_img.save(img_path, format="PNG")
        print(f"[Sprite] Made background transparent for {os.path.basename(img_path)}")
        return img_path
    except Exception as e:
        print(f"[Sprite Transparency Error] {e}")
        return [img_path]

def match_word(pattern, text):
    import re
    return bool(re.search(r'' + pattern + r'', text, re.IGNORECASE))

def get_surface_prompts(wall_style):
    ui = wall_style.lower()
    
    if any(k in ui for k in ['sci-fi', 'sci fi', 'spaceship', 'space station', 'alien ship', 'future']):
        wall_p = "A flat 2D game texture map of a dark sci-fi spaceship hull wall with glowing cyan neon panel lines, flat orthographic front view, zero perspective, purely flat material."
        ceil_p = "A flat 2D game texture map of a dark sci-fi spaceship ceiling with glowing blue and white light panels, directly overhead 90 degree view."
        floor_p = "A flat 2D game texture map of dark metal spaceship deck floor grating with glowing cyan lights, directly 90 degree bird's-eye top-down view, flat terrain texture."

    elif any(k in ui for k in ['win95', 'windows 95', 'windows', 'win 95', 'brick', '95', 'retro brick']):
        wall_p = "Authentic Windows 95 3D maze screensaver wall texture, bold chunky crimson red bricks with thick stark white mortar lines, flat straight-on orthographic view, seamless repeating 2D pattern, retro 90s low-poly CGI, bright uniform lighting, zero shadows, no borders."
        ceil_p = "Authentic Windows 95 acoustic drop ceiling tile texture, bright white and speckled grey mineral fiber surface with clean metal grid seams, flat straight-on view, seamless repeating 2D pattern, retro 90s computer graphics."
        floor_p = "Authentic Windows 95 parquet wood floor texture, seamless repeating golden honey oak wood tiles with subtle woodgrain, directly 90 degree top-down view, uniform flat lighting, zero shadows, zero perspective, perfectly repeating 2D floor pattern."
    
    elif any(k in ui for k in ['forest', 'nature', 'jungle', 'woods', 'woodland', 'trees', 'tree', 'garden', 'swamp']):
        wall_p = "A flat 2D game texture map of rough mossy tree bark and vertical redwood trunk surface, close-up flat orthographic front view, retro 90s video game wall texture, zero horizon, zero sky, zero perspective, pure flat vertical material."
        ceil_p = "A flat 2D game texture map of dense fine-grained green leafy foliage and pine canopy, directly 90 degree overhead view looking straight up, seamless tileable canopy, zero trunks."
        floor_p = "A flat 2D game texture map of dense fine-grained mossy ground cover, uniform rich dark earth covered evenly with seamless small green moss patches and tiny pine needles, fine-grained isotropic texture, directly 90 degree bird's-eye top-down view, uniform repeating ground surface, zero large focal objects, zero trees, zero sky, zero horizon, zero perspective, flat albedo terrain map."

    elif any(k in ui for k in ['taco', 'tacos', 'burrito', 'mexican', 'nacho', 'fajita']):
        wall_p = "A flat 2D wallpaper texture of crispy golden corn taco shells filled with seasoned meat, diced tomatoes, lettuce, and shredded cheese, colorful repeating 90s video game graphic pattern, flat 2D orthographic view, no room, no borders."
        ceil_p = "A flat 2D acoustic drop ceiling texture with warm golden corn tortilla grid panels, directly overhead 90 degree top-down view."
        floor_p = "A flat 2D game texture map of toasted warm corn meal and golden crushed tortilla chip crumbs ground terrain, directly 90 degree bird's-eye top-down view, uniform flat ground material, zero large objects, pure flat terrain."

    elif match_word('ladies', ui) or match_word('lady', ui) or match_word('women', ui) or match_word('woman', ui) or match_word('girls', ui) or match_word('girl', ui):
        wall_p = "A flat 2D pop-art wallpaper texture filled with dense repeating colorful comic book character portraits and faces of women, colorful 90s video game graphic collage, flat 2D repeating pattern, bright saturated colors, no text, no magazines, no room, no borders, clean repeating wallpaper."
        ceil_p = "A flat 2D drop ceiling tile texture with purple and gold geometric grid lines, directly overhead 90 degree top-down view, clean repeating square tiles."
        floor_p = "A flat 2D game texture map of magenta and purple checkered velvet carpet floor tiles with gold diamond geometric pattern, directly 90 degree bird's-eye top-down view, clean flat floor material, zero people on floor, zero standing figures, zero horizon, pure flat floor texture."
    
    elif match_word('people', ui) or match_word('person', ui) or match_word('crowd', ui) or match_word('characters', ui) or match_word('men', ui) or match_word('man', ui) or match_word('guys', ui):
        wall_p = "Retro 90s video game wallpaper texture filled with a dense crowd of colorful illustrated comic book character portraits and faces, vibrant pop-art character collage, flat 2D repeating pattern, bright saturated colors, no text, no room, no borders."
        ceil_p = "Retro 90s gaming acoustic drop ceiling tile texture with blue and white grid panels, flat overhead view."
        floor_p = "Retro 90s video game floor texture, rich navy blue and cobalt checkered carpet floor tiles with gold seams, directly 90 degree top-down view, clean flat floor material, zero people on floor."

    elif any(k in ui for k in ['cyber', 'neon', 'cyberpunk', 'matrix', 'circuits', 'tech']):
        wall_p = "A flat 2D texture map of dark metal cyber panels with glowing cyan and electric purple neon circuit conduits, flat orthographic front view, zero perspective."
        ceil_p = "A flat 2D texture map of dark steel ceiling plates with illuminated cyan neon grates, directly overhead 90 degree view."
        floor_p = "A flat 2D texture map of dark hexagonal metal floor tiles with pulsing cyan neon seams, directly 90 degree bird's-eye top-down view, zero horizon, zero perspective, pure flat floor material."
    
    elif any(k in ui for k in ['moss', 'stone', 'castle', 'dungeon', 'ancient', 'cave', 'rock']):
        wall_p = "A flat 2D texture map of weathered grey dungeon castle stone blocks with green moss in mortar cracks, flat orthographic front view, zero perspective."
        ceil_p = "A flat 2D texture map of ancient dark stone ceiling slabs with green moss patches, directly overhead 90 degree view."
        floor_p = "A flat 2D texture map of weathered grey cobblestone flagstones with dirt seams, directly 90 degree bird's-eye top-down view, zero walls, zero sky, zero horizon, pure flat ground texture."
    
    elif any(k in ui for k in ['candy', 'gingerbread', 'sweet', 'peppermint', 'cake', 'chocolate', 'cookie']):
        wall_p = "A flat 2D wallpaper texture of red and white peppermint candy cane stripes and gingerbread cookie pattern with white icing, bold saturated colors, flat straight-on view, zero perspective."
        ceil_p = "A flat 2D texture of pastel pink cotton candy and marshmallow clouds with rainbow sprinkles, directly overhead 90 degree view."
        floor_p = "A flat 2D texture map of dark chocolate cookie crumb ground tiles with caramel glaze seams, directly 90 degree bird's-eye top-down view, zero horizon, pure flat ground material."
    
    elif any(k in ui for k in ['cat', 'cats', 'kitten', 'kittens', 'feline', 'dog', 'dogs', 'puppy', 'animal']):
        wall_p = f"Retro 90s video game wallpaper texture filled with a dense crowd of colorful illustrated cute {wall_style} faces, vibrant colorful pop-art pattern, flat 2D repeating wallpaper, no text, no room, no borders."
        ceil_p = f"Retro 90s acoustic ceiling tiles with subtle cream and white paw print motifs, directly overhead 90 degree view."
        floor_p = f"Retro 90s warm honey oak wood parquet floor tiles with subtle cute paw prints, directly 90 degree bird's-eye top-down view, uniform flat lighting, zero 3D figures on floor."

    else:
        wall_p = f"A flat 2D vertical wall surface texture of {wall_style}, close-up flat orthographic front view, vibrant retro 90s video game wallpaper material, zero horizon, zero sky, zero landscape, pure flat vertical wall material."
        ceil_p = f"A flat 2D overhead sky canopy or ceiling texture themed after {wall_style}, clean flat 90 degree top-down overhead view, zero walls, zero ground, zero horizon, pure tileable overhead material."
        floor_p = f"A flat 2D top-down fine-grained ground terrain floor texture themed after {wall_style}, close-up flat 90 degree bird's-eye view of the ground surface, uniform macro ground material, zero large focal objects, zero standing trees, zero people, zero horizon, zero sky, pure flat ground terrain material."
    
    return wall_p, ceil_p, floor_p



def generate_flux_all_assets(wall_style, player_style=None, player_image_b64=None):
    """Generate Dungeon Textures (Wall, Ceil, Floor) + AI Face Portrait + Player Character Sprite in FLUX."""
    prefix_w = f"trio_w_{int(time.time()*1000)}"
    prefix_c = f"trio_c_{int(time.time()*1000)}"
    prefix_f = f"trio_f_{int(time.time()*1000)}"
    prefix_p = f"player_{int(time.time()*1000)}"
    prefix_face = f"face_{int(time.time()*1000)}"
    
    wall_p, ceil_p, floor_p = get_surface_prompts(wall_style)
    
    # Process Player Character Appearance & Face Portrait (Modular Rig Design)
    if player_image_b64 and "," in player_image_b64:
        portrait_prompt = (
            "Close-up front view video game status portrait of a valiant warrior hero, bald shaved head, stylish wireframe glasses, "
            "determined heroic warrior expression, wearing a yellow tunic shirt and dark leather armor straps, Doom and Valbrace game status portrait style, "
            "atmospheric dark dungeon background, highly detailed character portrait, 8k resolution, crisp lighting."
        )
        player_prompt = (
            "Photorealistic 3D game render of a realistic muscular warrior character seen directly from behind in a strict third-person back view, perfectly centered, spine totally straight, 0 degree angle, "
            "cinematic lighting, highly detailed realistic textures, bald shaved head with dark wireframe glasses visible from the side, "
            "wearing a realistic yellow cloth tunic and weathered leather armor harness, holding a glowing sword in the right hand and a sturdy shield in the left hand, ready for combat, dynamic action pose, "
            "8k resolution, Unreal Engine 5 aesthetic, photorealistic back view character body, pure solid white background."
        )
    elif player_style and player_style.strip():
        ps = player_style.strip().lower()
        if 'cat' in ps:
            portrait_prompt = (
                "Close-up front view video game portrait of a fierce anthropomorphic cat warrior hero, orange feline fur, sharp cat ears and green eyes, "
                "wearing leather armor collar, Doom status portrait style, atmospheric dark dungeon background, 8k resolution."
            )
            player_prompt = (
                "Photorealistic 3D game render of an anthropomorphic humanoid cat warrior standing on two legs, seen directly from behind in a strict third-person back view, perfectly centered, spine totally straight, 0 degree angle, "
                "realistic feline fur texture, cat ears and tail, wearing weathered leather warrior armor, broad shoulders, holding a glowing sword in the right hand and a sturdy shield in the left hand, ready for combat, dynamic action pose, "
                "cinematic lighting, 8k resolution, Unreal Engine 5 aesthetic, pure solid white background."
            )
        else:
            portrait_prompt = (
                f"Close-up front view video game portrait of a valiant {player_style} warrior hero, heroic expression, "
                f"Doom and Valbrace status portrait style, atmospheric dark dungeon background, 8k resolution, crisp lighting."
            )
            player_prompt = (
                f"Photorealistic 3D game render of a realistic {player_style} warrior seen directly from behind in a strict third-person back view, perfectly centered, spine totally straight, 0 degree angle, cinematic lighting, highly detailed realistic textures, 8k resolution, Unreal Engine 5 aesthetic, pure solid white background."
            )
    else:
        portrait_prompt = (
            "Close-up front view video game portrait of an armored warrior knight hero, heroic determined expression, "
            "Doom and Valbrace status portrait style, atmospheric dark dungeon background, 8k resolution, crisp lighting."
        )
        player_prompt = (
            "Photorealistic 3D game render of a realistic armored warrior knight seen directly from behind in a strict third-person back view, perfectly centered, spine totally straight, 0 degree angle, "
            "cinematic lighting, highly detailed steel plate armor and weathered leather, broad shoulders, holding a glowing sword in the right hand and a sturdy shield in the left hand, ready for combat, dynamic action pose, 8k resolution, Unreal Engine 5 aesthetic, pure solid white background."
        )

    print(f"[FLUX Dungeon, Player & Portrait Prompts]\n Wall: {wall_p}\n Portrait: {portrait_prompt}\n Player: {player_prompt}")

    prompt_payload = {
        "1": {"inputs": {"ckpt_name": "flux1-schnell-fp8.safetensors"}, "class_type": "CheckpointLoaderSimple"},
        "neg": {"inputs": {"text": "cartoon, anime, 2d, low quality, pixelated, 16-bit, clipart, drawing, blurry, watermark", "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        
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
        "f_save": {"inputs": {"filename_prefix": prefix_f, "images": ["f_dec", 0]}, "class_type": "SaveImage"},

        # Player Character Sprite
        "p_lat": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "p_pos": {"inputs": {"text": player_prompt, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        "p_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["p_pos", 0], "negative": ["neg", 0], "latent_image": ["p_lat", 0]}, "class_type": "KSampler"},
        "p_dec": {"inputs": {"samples": ["p_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
        "p_save": {"inputs": {"filename_prefix": prefix_p, "images": ["p_dec", 0]}, "class_type": "SaveImage"},

        # AI Face Portrait (Front View)
        "face_lat": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "face_pos": {"inputs": {"text": portrait_prompt, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        "face_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["face_pos", 0], "negative": ["neg", 0], "latent_image": ["face_lat", 0]}, "class_type": "KSampler"},
        "face_dec": {"inputs": {"samples": ["face_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
        "face_save": {"inputs": {"filename_prefix": prefix_face, "images": ["face_dec", 0]}, "class_type": "SaveImage"}
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
                if "w_save" in outputs and "c_save" in outputs and "f_save" in outputs and "p_save" in outputs and "face_save" in outputs:
                    w_img = outputs["w_save"]["images"][0]["filename"]
                    c_img = outputs["c_save"]["images"][0]["filename"]
                    f_img = outputs["f_save"]["images"][0]["filename"]
                    p_img = outputs["p_save"]["images"][0]["filename"]
                    face_img = outputs["face_save"]["images"][0]["filename"]
                    
                    w_sub = outputs["w_save"]["images"][0].get("subfolder", "")
                    c_sub = outputs["c_save"]["images"][0].get("subfolder", "")
                    f_sub = outputs["f_save"]["images"][0].get("subfolder", "")
                    p_sub = outputs["p_save"]["images"][0].get("subfolder", "")
                    face_sub = outputs["face_save"]["images"][0].get("subfolder", "")
                    
                    w_path = os.path.join(COMFY_OUTPUT_DIR, w_sub, w_img)
                    c_path = os.path.join(COMFY_OUTPUT_DIR, c_sub, c_img)
                    f_path = os.path.join(COMFY_OUTPUT_DIR, f_sub, f_img)
                    p_path = os.path.join(COMFY_OUTPUT_DIR, p_sub, p_img)
                    face_path = os.path.join(COMFY_OUTPUT_DIR, face_sub, face_img)
                    
                    make_seamless_4way(w_path, blend_pixels=12)
                    make_seamless_4way(c_path, blend_pixels=12)
                    make_seamless_4way(f_path, blend_pixels=12)
                    make_sprite_transparent(p_path)
                    
                    return w_path, c_path, f_path, p_path, face_path
                    
    raise TimeoutError("FLUX.1 Dungeon, Player & Portrait generation timed out.")


def run_batch_v3_flux(wall_style, player_style=None, player_image=None):
    """v3 FLUX.1 [schnell] mode: Generates 3 Dungeon Surfaces + 1 Player Character Sprite + 1 AI Face Portrait."""
    global gen_progress
    gen_progress["is_generating"] = True
    gen_progress["completed_bundle"] = None
    gen_progress["error"] = None
    gen_progress["current_step"] = 0
    gen_progress["total_steps"] = 2

    try:
        gen_progress["current_step"] = 1
        gen_progress["status_message"] = "Synthesizing Dungeon, Character & AI Portrait with FLUX.1 [schnell]..."
        gen_progress["percent"] = 50

        w_path, c_path, f_path, p_path, face_path = generate_flux_all_assets(wall_style, player_style, player_image)

        gen_progress["current_step"] = 2
        gen_progress["status_message"] = "Assembling 3D World & Valbrace Combat..."
        gen_progress["percent"] = 90

        with open(w_path, "rb") as tf:
            w_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        with open(c_path, "rb") as tf:
            c_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        with open(f_path, "rb") as tf:
            f_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        with open(p_path, "rb") as tf:
            p_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        with open(face_path, "rb") as tf:
            face_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"

        gen_progress["percent"] = 100
        gen_progress["status_message"] = "FLUX.1 Dungeon & Character Ready!"
        gen_progress["completed_bundle"] = {
            "mode": "v3_flux",
            "wall_style": wall_style,
            "wall_texture": w_b64,
            "ceiling_texture": c_b64,
            "floor_texture": f_b64,
            "player_sprite": p_b64,
            "player_face": face_b64
        }
        print("[FLUX.1] Dungeon textures, character sprite, and AI portrait complete and packaged!")

    except Exception as e:
        print(f"[FLUX.1 Error] {e}")
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
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            data = json.loads(body)
            wall_style = data.get("wall_style", "Windows 95")
            player_style = data.get("player_style", "")
            player_image = data.get("player_image", None)
            mode = data.get("mode", "v3_flux")

            # Reset progress synchronously
            gen_progress["is_generating"] = True
            gen_progress["completed_bundle"] = None
            gen_progress["error"] = None
            gen_progress["current_step"] = 1
            gen_progress["total_steps"] = 2
            gen_progress["status_message"] = "Synthesizing 3D Dungeon & Character with FLUX.1 [schnell]..."
            gen_progress["percent"] = 25

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "message": f"{mode} generation started"}, ensure_ascii=True).encode("utf-8"))

            t = threading.Thread(target=run_batch_v3_flux, args=(wall_style, player_style, player_image), daemon=True)
            t.start()
            return

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
