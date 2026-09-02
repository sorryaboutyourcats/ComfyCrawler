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


PLAYER_FRAME_NAMES = ["idle", "block", "windup", "slash", "hurt"]

# Standard 18-point OpenPose body layout: 0 Nose, 1 Neck, 2 RShoulder, 3 RElbow, 4 RWrist,
# 5 LShoulder, 6 LElbow, 7 LWrist, 8 RHip, 9 RKnee, 10 RAnkle, 11 LHip, 12 LKnee, 13 LAnkle,
# 14 REye, 15 LEye, 16 REar, 17 LEar. Limb pairs/colors match the canonical OpenPose ControlNet
# rendering convention exactly (verified against comfyui_controlnet_aux's draw_bodypose).
# Face points (14-17) are omitted on purpose - it reinforces the back-view-only framing, since
# there's no face to draw.
POSE_LIMB_SEQ = [
    (1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10),
    (1, 11), (11, 12), (12, 13), (1, 0), (0, 14), (14, 16), (0, 15), (15, 17),
]
POSE_COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0),
    (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255),
    (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85),
]

# Hand-authored back-view keypoints (normalized 0-1) for each combat frame. "R"/"L" here just
# means "appears on the right/left side of the canvas" - self-consistency across limbs matters,
# not literal anatomical labeling, since ControlNet only cares about the visual/geometric structure.
PLAYER_POSE_KEYPOINTS = {
    # Last 4 entries are REye, LEye, REar, LEar. Eyes stay None (no face - back view), but both
    # ears are given small SYMMETRIC points close together near the top of the neck: a back-of-head
    # is what a real photo would show two visible, near-symmetric ears with no eyes/nose between
    # them - that asymmetry-free signal is what was missing and let orientation drift frame to frame.
    # The sword arm (RShoulder/RElbow/RWrist, indices 2/3/4) traces a real Valbrace-style arc across
    # the frames: upright at rest -> cocked back across the body -> swept through to the right. The
    # RWrist point is doing double duty - it poses the arm here AND anchors the composited blade in
    # PLAYER_SWORD_TRANSFORMS below, so the hand and the weapon can never drift out of sync.
    # The shield-arm wrist sits OUTSIDE the torso silhouette (x around 0.28 rather than 0.40).
    # The shield is centred exactly on this point, so the only way it can be both attached to the
    # hand and not swallowed by the body is for the hand itself to be held clear of the body.
    "idle": [
        None, (0.50, 0.22),
        (0.59, 0.25), (0.65, 0.38), (0.68, 0.48),
        (0.42, 0.25), (0.35, 0.37), (0.28, 0.46),
        (0.56, 0.52), (0.57, 0.72), (0.57, 0.92),
        (0.44, 0.52), (0.43, 0.72), (0.43, 0.92),
        None, None, (0.545, 0.185), (0.455, 0.185),
    ],
    # Identical to idle apart from the shield arm - block should read as the same character lifting
    # their guard, not as a different frame entirely. The hand travels up WITH the shield, since
    # the shield is pinned to this wrist point.
    "block": [
        None, (0.50, 0.22),
        (0.59, 0.25), (0.65, 0.38), (0.68, 0.48),
        (0.42, 0.25), (0.33, 0.34), (0.31, 0.25),
        (0.56, 0.52), (0.57, 0.72), (0.57, 0.92),
        (0.44, 0.52), (0.43, 0.72), (0.43, 0.92),
        None, None, (0.545, 0.185), (0.455, 0.185),
    ],
    # Windup is ONE arm cocked back across the chest, not both arms in the air - the old
    # both-hands-overhead pose is what read as "player just raising two arms" with no weapon.
    # Sword arm raised into a guard beside the shoulder - NOT folded across the chest. The crossed
    # version asked for a forearm reaching past the body's centreline in a back view, which is
    # anatomically ambiguous from behind; the model consistently resolved it by splaying BOTH arms
    # out and stretching them to the frame edges, and it rendered the figure at a different scale
    # from every other frame too. Because the blade is composited separately, its rotation alone
    # carries the "cocked back to strike" read - the arm doesn't have to contort to sell it.
    # Left arm is identical to idle, so only the sword arm changes.
    # The sword hand is held high and wide so the cocked blade sweeps up-left ABOVE the head rather
    # than across the torso - now that gear draws behind the character, a blade crossing the body
    # is completely hidden by it.
    "windup": [
        None, (0.50, 0.22),
        (0.60, 0.25), (0.72, 0.31), (0.78, 0.26),
        (0.42, 0.25), (0.35, 0.37), (0.28, 0.46),
        (0.56, 0.52), (0.57, 0.72), (0.57, 0.92),
        (0.44, 0.52), (0.43, 0.72), (0.43, 0.92),
        None, None, (0.545, 0.185), (0.455, 0.185),
    ],
    "slash": [
        None, (0.48, 0.20),
        (0.60, 0.24), (0.68, 0.28), (0.74, 0.34),
        (0.38, 0.24), (0.32, 0.34), (0.27, 0.44),
        (0.54, 0.52), (0.62, 0.70), (0.68, 0.90),
        (0.42, 0.52), (0.38, 0.76), (0.34, 0.94),
        None, None, (0.525, 0.165), (0.435, 0.165),
    ],
    "hurt": [
        None, (0.52, 0.24),
        (0.60, 0.27), (0.66, 0.34), (0.70, 0.40),
        (0.44, 0.27), (0.36, 0.37), (0.29, 0.47),
        (0.58, 0.54), (0.62, 0.74), (0.66, 0.94),
        (0.46, 0.54), (0.40, 0.70), (0.34, 0.88),
        None, None, (0.565, 0.205), (0.475, 0.205),
    ],
}

# The sword is generated ONCE as its own sprite and composited into every frame, rather than asked
# for inside each character generation. OpenPose has no channel for "and there's a blade in that
# hand" - it can only place joints - so the model kept posing the arms correctly and then drawing
# nothing in them. Compositing also means it is literally the same blade in all five frames instead
# of five separately-hallucinated ones. This still satisfies "weapon is one with the frame": the
# compositing happens here, server-side, so what ships to the browser is a single flat PNG per
# frame with nothing left for the frontend to keep in sync.
#
# The sword sprite is generated blade-up with the grip at the bottom, so `angle` is a plain
# counter-clockwise rotation about the grip: 0 = held upright, positive = cocked left,
# negative = swung right. `scale` is blade length as a fraction of frame height.
# Offsets zero for the same reason as the shield: the grip belongs in the hand, not near it.
PLAYER_SWORD_TRANSFORMS = {
    "idle":   {"angle":    0, "scale": 0.40, "offset": (0.00,  0.00), "streak": None},
    "block":  {"angle":  -25, "scale": 0.34, "offset": (0.00,  0.00), "streak": None},
    # Blade swept up and across to the left from the raised guard hand - this is what actually
    # reads as "cocked back", now that the arm itself stays in a natural position.
    "windup": {"angle":   45, "scale": 0.34, "offset": (0.00,  0.00), "streak": None},
    # Follow-through: blade already swept down-right, with the white arc above tracing where it
    # travelled - the same read as Valbrace's swipe frame.
    "slash":  {"angle": -145, "scale": 0.40, "offset": (0.00,  0.00),
               # Arcs from where the blade was at windup, up over the shoulder and down to where it
               # is now - deliberately clearing the head rather than cutting across it.
               "streak": {"points": [(0.30, 0.22), (0.44, 0.08), (0.66, 0.09), (0.82, 0.26),
                                     (0.88, 0.40)],
                          "width": 0.022}},
    "hurt":   {"angle": -150, "scale": 0.34, "offset": (0.00,  0.00), "streak": None},
}

# Shield placement, anchored to the LEFT wrist (keypoint 7) the same way the sword is anchored to
# the right - so the shield tracks whatever the ControlNet skeleton did with the shield arm. Unlike
# the sword this is centred on the anchor rather than pivoted from one end, since a round shield is
# strapped across the forearm rather than gripped at one tip.
# Offsets are all ZERO: the shield's centre sits exactly on the left-hand keypoint, because that
# is where a hand gripping the back of a shield actually is. Nudging the shield outward to keep it
# clear of the torso (an earlier attempt) visibly detached it from the hand - the shield floated
# and the arm pointed somewhere else. The hand is moved out in PLAYER_POSE_KEYPOINTS instead, so
# the two stay welded together and the shield still clears the body.
PLAYER_SHIELD_TRANSFORMS = {
    "idle":   {"angle":   0, "scale": 0.27, "offset": (0.0, 0.0)},
    # Braced: the biggest it gets, reading as brought up into the incoming hit.
    "block":  {"angle":   0, "scale": 0.34, "offset": (0.0, 0.0)},
    "windup": {"angle": -12, "scale": 0.26, "offset": (0.0, 0.0)},
    "slash":  {"angle": -20, "scale": 0.25, "offset": (0.0, 0.0)},
    "hurt":   {"angle":  18, "scale": 0.26, "offset": (0.0, 0.0)},
}


def render_pose_skeleton(pose_name, size=768):
    """Render a pose as an OpenPose-style skeleton PNG into ComfyUI's input folder, for use as
    ControlNet conditioning. Pure PIL - no opencv dependency needed for this simplified version."""
    from PIL import Image, ImageDraw
    kps = PLAYER_POSE_KEYPOINTS[pose_name]
    canvas = Image.new("RGB", (size, size), (0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    stick_width = max(4, size // 100)

    for (i1, i2), color in zip(POSE_LIMB_SEQ, POSE_COLORS):
        p1, p2 = kps[i1], kps[i2]
        if p1 is None or p2 is None:
            continue
        dim_color = tuple(int(c * 0.6) for c in color)
        draw.line([(p1[0] * size, p1[1] * size), (p2[0] * size, p2[1] * size)], fill=dim_color, width=stick_width * 2)

    for kp, color in zip(kps, POSE_COLORS):
        if kp is None:
            continue
        x, y = kp[0] * size, kp[1] * size
        draw.ellipse([x - stick_width, y - stick_width, x + stick_width, y + stick_width], fill=color)

    filename = f"pose_skel_{pose_name}.png"
    canvas.save(os.path.join(COMFY_INPUT_DIR, filename), format="PNG")
    return filename




def get_player_sprite_prompts(player_style):
    """Retro flat 2D low-poly prompts for the IPAdapter-conditioned player sprite pipeline.
    Weapon + shield are baked into the character description itself (not drawn as separate overlays)."""
    p_style = player_style.strip() if (player_style and player_style.strip()) else "armored knight"

    # Pose clause goes FIRST and the shared style/background text is kept short - CLIP truncates
    # at 77 tokens, and a long shared prefix was silently cutting off the pose-differentiating
    # text every time, which is why earlier attempts produced near-identical frames.
    # NOTE: the character is deliberately generated EMPTY-HANDED. Sword and shield are separately
    # generated sprites composited in afterwards (see PLAYER_SWORD_TRANSFORMS / SHIELD), so asking
    # for them here would only produce a second, differently-drawn set fighting the composited one.
    # Dropping them also permanently kills the old "two shields / two swords" confusion: there is
    # now nothing held in the prompt for the model to duplicate or mix up.
    # The orientation clauses carry explicit CLIP weights because back-view was otherwise a coin
    # flip per seed - some references came back facing the camera, and IPAdapter then propagated
    # that to all five frames. Only ORIENTATION words are weighted: an earlier attempt at weighting
    # face/species words ("muzzle", "animal face") to suppress the face also erased what made a cat
    # a cat, and the brief is explicitly that every species has to still work.
    tail = (
        f"Single {p_style} warrior, only one figure in the image, "
        f"(low-poly flat-shaded retro 90s video game character sprite:1.35). "
        f"(Viewed from directly behind:1.5), (back of the head visible:1.4), (facing away from the viewer:1.4), "
        f"turned to face deeper into the scene toward a distant enemy, spine straight, centered. "
        f"Both hands empty, closed in gripping fists, carrying nothing. "
        f"Isolated alone on a solid plain white background, no room, no floor, no scenery."
    )

    reference_prompt = f"Neutral standing pose, arms relaxed at the sides. {tail}"

    pose_prompts = [
        f"Standing idle stance, weight balanced evenly, right arm hanging relaxed at the side. {tail}",
        f"Shield raised up and forward, bracing to block an incoming attack. {tail}",
        f"Right arm cocked back low across the chest, coiled and about to strike. {tail}",
        f"Mid-swing dynamic action pose, right arm swept through to the side, torso twisted into the "
        f"swing, front leg lunging forward. {tail}",
        f"Staggering backward off-balance, recoiling from a hit, shield dropped low. {tail}",
    ]

    player_negative = (
        "(front view:1.5), (facing the camera:1.5), (facing the viewer:1.4), (looking at viewer:1.4), "
        "(sword:1.4), (holding a weapon:1.4), blade, axe, spear, staff, shield, buckler, "
        "portrait, eye contact, "
        "two characters, twins, duplicate character, multiple views, character turnaround, character sheet, "
        "reference sheet, concept art sheet, weapon closeup, item icons, ui text, labels, callouts, "
        "front and back view, two poses, split screen, mirrored duplicate, side by side, "
        "two shields, twin shields, matching shields, symmetric shields, "
        "turned around, three quarter view, side view, profile view, "
        "comic book art, ink outlines, heavy black outlines, inked linework, cel shaded illustration, "
        "manga, anime, pinup, painterly, watercolor, sketch, "
        "room, floor, wall, walls, tile floor, doorway, window, interior, architecture, ground, ground plane, "
        "photorealistic, 3d render, realistic skin texture, detailed background, scenery, landscape, environment, "
        "desert, rocks, cliffs, buildings, horizon, sky, blurry, watermark, cropped, extra limbs, deformed hands, "
        "multiple characters, text, signature, ugly, bad anatomy, disfigured, jpeg artifacts"
    )

    return reference_prompt, pose_prompts, player_negative


def get_sword_prompts(player_style):
    """Prompt pair for the one-off sword sprite that gets composited into every frame.
    Generated blade-up with the grip at the bottom so rotation about the grip is trivial."""
    p_style = player_style.strip() if (player_style and player_style.strip()) else "armored knight"
    sword_positive = (
        f"A single sword weapon held vertically, blade pointing straight up, hilt crossguard and grip at the "
        f"bottom, one straight double-edged blade, flat side-on view. Low-poly flat-shaded retro 90s video game "
        f"item sprite, styled to match a {p_style} warrior. Isolated alone on a solid plain white background, "
        f"no character, no person, no hands."
    )
    sword_negative = (
        "person, character, human, warrior, knight, hand, hands, arm, arms, body, face, holding, wielding, "
        "two swords, multiple swords, crossed swords, pair of swords, sword rack, weapon collection, "
        "shield, item icons, ui text, labels, inventory grid, "
        "horizontal sword, diagonal sword, tilted, room, floor, scenery, background, landscape, "
        "photorealistic, 3d render, blurry, watermark, cropped, text, signature, jpeg artifacts"
    )
    return sword_positive, sword_negative


def get_portrait_prompts(player_style):
    """Prompt pair for the status-panel portrait. Generated inside the player-sprite pipeline (not
    the FLUX texture batch) so it can be IPAdapter-conditioned on the SAME reference the animation
    frames use - a separately generated portrait had no way to resemble the actual character.
    This is the one place a face IS wanted, since it's the HUD mugshot rather than the sprite."""
    p_style = player_style.strip() if (player_style and player_style.strip()) else "armored knight"
    # Weights are kept deliberately LIGHT here. A version of this with half a dozen terms at 1.4-1.5
    # collapsed some seeds into an abstract kaleidoscope with no character in it at all - the same
    # fragility this 8-step distilled model showed when given heavy multi-conditioning elsewhere.
    # One head, facing forward, is carried mostly by plain wording.
    portrait_positive = (
        f"Head and shoulders portrait of one {p_style} warrior, (facing the viewer:1.2), a single "
        f"centered bust filling the frame, determined expression. Low-poly flat-shaded retro 90s "
        f"video game character art. Plain solid light background."
    )
    portrait_negative = (
        "back view, facing away, back of the head, rear view, "
        "two characters, multiple heads, duplicate, character sheet, multiple views, "
        "grid, tiled, side by side, mirrored, "
        "full body, legs, feet, weapon, sword, shield, "
        "trees, forest, sky, room, floor, scenery, landscape, detailed background, "
        "photorealistic, 3d render, blurry, watermark, cropped, text, signature, jpeg artifacts"
    )
    return portrait_positive, portrait_negative


def get_shield_prompts(player_style):
    """Prompt pair for the one-off shield sprite composited onto the left arm in every frame.
    Like the sword, this is generated separately because the character pass kept declining to
    draw a shield at all - and when it did, it sometimes drew two."""
    p_style = player_style.strip() if (player_style and player_style.strip()) else "armored knight"
    # The style words describe the shield's MATERIALS AND COLOURS, never its subject. Phrased as
    # "styled to match a {style} warrior" the model painted the style noun onto the shield as a
    # crest - a "cat" warrior got a shield with a big cat portrait on it, which is both odd and
    # precisely the face the rest of the pipeline works to keep out of frame.
    shield_positive = (
        f"A single round battle shield seen face-on, one circular shield with a plain raised central boss "
        f"and a decorated rim, bare undecorated surface, no emblem, no crest, no painted figure. Low-poly "
        f"flat-shaded retro 90s video game item sprite, in the colours and materials of a {p_style} "
        f"warrior's gear. Isolated alone and centered on a solid plain white background, no character, "
        f"no person, no hands, no sword."
    )
    shield_negative = (
        "(face:1.6), (animal head:1.6), (portrait:1.5), (emblem:1.4), (crest:1.4), "
        "heraldry, coat of arms, painted animal, mascot, logo, "
        "spiked wheel, chakram, throwing star, cog, gear, saw blade, spikes, blades on the rim, "
        "face on the shield, animal face, cat face, eyes, muzzle, mask, "
        "person, character, human, warrior, knight, hand, hands, arm, arms, body, face, holding, wielding, "
        "sword, blade, weapon, spear, axe, crossed weapons, "
        "two shields, multiple shields, pair of shields, shield rack, collection, row of shields, "
        "item icons, ui text, labels, inventory grid, room, floor, scenery, background, landscape, "
        "photorealistic, 3d render, blurry, watermark, cropped, text, signature, jpeg artifacts"
    )
    return shield_positive, shield_negative


def generate_player_sprite_ipadapter(player_style):
    """Generate one clean reference character with SDXL-Lightning, then 5 pose frames
    IPAdapter-conditioned on that reference (idle, block, windup, slash, hurt), all sharing
    one locked seed for consistency. Each frame is background-removed independently, then has the
    separately-generated sword and shield composited into its hands.

    Returns (frame_paths, portrait_path)."""
    reference_prompt, pose_prompts, player_negative = get_player_sprite_prompts(player_style)
    sword_positive, sword_negative = get_sword_prompts(player_style)
    shield_positive, shield_negative = get_shield_prompts(player_style)
    portrait_positive, portrait_negative = get_portrait_prompts(player_style)
    seed = random.randint(1, 1000000000)
    prefix_ref = f"player_ref_{int(time.time()*1000)}"

    payload = {
        "ckpt": {"inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"}, "class_type": "CheckpointLoaderSimple"},
        "lora": {"inputs": {"model": ["ckpt", 0], "clip": ["ckpt", 1], "lora_name": "sdxl_lightning_8step_lora.safetensors", "strength_model": 1.0, "strength_clip": 1.0}, "class_type": "LoraLoader"},
        "neg": {"inputs": {"text": player_negative, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        "ipa_loader": {"inputs": {"model": ["lora", 0], "preset": "PLUS (high strength)"}, "class_type": "IPAdapterUnifiedLoader"},

        "ref_lat": {"inputs": {"width": 768, "height": 768, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "ref_pos": {"inputs": {"text": reference_prompt, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        # The reference gets the SAME ControlNet skeleton treatment as the frames. Left unposed it
        # very often came back as a character TURNAROUND SHEET - front, side and back view side by
        # side - and IPAdapter then faithfully propagated both the duplicate figures and the
        # contradictory facing into all five frames. Pinning it to the idle skeleton guarantees the
        # reference is exactly one figure at a known back-view orientation.
        "ref_pose_img": {"inputs": {"image": render_pose_skeleton("idle")}, "class_type": "LoadImage"},
        "ref_cn": {"inputs": {"positive": ["ref_pos", 0], "negative": ["neg", 0], "control_net": ["cn_loader", 0], "image": ["ref_pose_img", 0], "strength": 0.9, "start_percent": 0.0, "end_percent": 1.0}, "class_type": "ControlNetApplyAdvanced"},
        "ref_samp": {"inputs": {"seed": seed, "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["lora", 0], "positive": ["ref_cn", 0], "negative": ["ref_cn", 1], "latent_image": ["ref_lat", 0]}, "class_type": "KSampler"},
        "ref_dec": {"inputs": {"samples": ["ref_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"},
        # IPAdapter is fed a wide medium shot of the reference rather than the whole frame: the
        # reference keeps drawing a sword into the character's hand however hard the negative
        # argues, and IPAdapter then copies that blade into all five frames as a second sword
        # fighting the composited one. Trimming the bottom drops most dangling gear.
        # Cut off above the hands (which sit around y=400), since that is where a stray blade hangs.
        # Deliberately FULL WIDTH and still figure-shaped - an earlier 384x384 head-and-torso crop
        # turned this into a portrait reference, and portraits face the camera, which swung every
        # frame round to front-facing.
        "ref_crop": {"inputs": {"image": ["ref_dec", 0], "width": 768, "height": 400, "x": 0, "y": 0}, "class_type": "ImageCrop"},
        "ref_save": {"inputs": {"filename_prefix": prefix_ref, "images": ["ref_dec", 0]}, "class_type": "SaveImage"},

        "bg_model": {"inputs": {"bg_removal_name": "birefnet.safetensors"}, "class_type": "LoadBackgroundRemovalModel"},
        "cn_loader": {"inputs": {"control_net_name": "SDXL\\OpenPoseXL2.safetensors"}, "class_type": "ControlNetLoader"},
    }

    # One-off sword sprite, generated blade-up on its own so it can be rotated about the grip and
    # composited into all five frames. IPAdapter runs in "style transfer" mode here (not linear) so
    # it picks up the reference character's palette/shading without dragging a body into the image.
    payload.update({
        "sword_neg": {"inputs": {"text": sword_negative, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        "sword_pos": {"inputs": {"text": sword_positive, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        "ipa_sword": {"inputs": {"model": ["lora", 0], "ipadapter": ["ipa_loader", 1], "image": ["ref_crop", 0], "weight": 0.4, "weight_type": "style transfer", "combine_embeds": "concat", "start_at": 0.0, "end_at": 1.0, "embeds_scaling": "V only"}, "class_type": "IPAdapterAdvanced"},
        "sword_lat": {"inputs": {"width": 768, "height": 768, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "sword_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["ipa_sword", 0], "positive": ["sword_pos", 0], "negative": ["sword_neg", 0], "latent_image": ["sword_lat", 0]}, "class_type": "KSampler"},
        "sword_dec": {"inputs": {"samples": ["sword_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"},
        "sword_mask": {"inputs": {"bg_removal_model": ["bg_model", 0], "image": ["sword_dec", 0]}, "class_type": "RemoveBackground"},
        "sword_maskinv": {"inputs": {"mask": ["sword_mask", 0]}, "class_type": "InvertMask"},
        "sword_save": {"inputs": {"filename_prefix": f"player_sword_{int(time.time()*1000)}", "images": ["sword_dec", 0], "mask": ["sword_maskinv", 0]}, "class_type": "SaveImageWithAlpha"},

        "shield_neg": {"inputs": {"text": shield_negative, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        "shield_pos": {"inputs": {"text": shield_positive, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        # The face-on-the-shield problem is handled in the prompt (which is where it came from -
        # the style noun was being painted on as a crest), so this can stay high enough to actually
        # pick up the character's palette; at 0.25 a neon character got a plain grey disc.
        "ipa_shield": {"inputs": {"model": ["lora", 0], "ipadapter": ["ipa_loader", 1], "image": ["ref_crop", 0], "weight": 0.45, "weight_type": "style transfer", "combine_embeds": "concat", "start_at": 0.0, "end_at": 1.0, "embeds_scaling": "V only"}, "class_type": "IPAdapterAdvanced"},
        "shield_lat": {"inputs": {"width": 768, "height": 768, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "shield_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["ipa_shield", 0], "positive": ["shield_pos", 0], "negative": ["shield_neg", 0], "latent_image": ["shield_lat", 0]}, "class_type": "KSampler"},
        "shield_dec": {"inputs": {"samples": ["shield_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"},
        "shield_mask": {"inputs": {"bg_removal_model": ["bg_model", 0], "image": ["shield_dec", 0]}, "class_type": "RemoveBackground"},
        "shield_maskinv": {"inputs": {"mask": ["shield_mask", 0]}, "class_type": "InvertMask"},
        "shield_save": {"inputs": {"filename_prefix": f"player_shield_{int(time.time()*1000)}", "images": ["shield_dec", 0], "mask": ["shield_maskinv", 0]}, "class_type": "SaveImageWithAlpha"},

        # HUD portrait. "strong style transfer" rather than "linear": at linear the reference's
        # BACK-view composition came through and the portrait rendered the back of the character's
        # head. Strong-style-transfer carries the design - species, palette, armour - while leaving
        # framing to the prompt, which is what lets this one actually face the viewer.
        "portrait_neg": {"inputs": {"text": portrait_negative, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        "portrait_pos": {"inputs": {"text": portrait_positive, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        # Weight kept moderate: "strong style transfer" at 0.9 sometimes overwhelmed the prompt
        # entirely and produced an abstract stained-glass pattern instead of a character.
        "ipa_portrait": {"inputs": {"model": ["lora", 0], "ipadapter": ["ipa_loader", 1], "image": ["ref_crop", 0], "weight": 0.7, "weight_type": "style transfer", "combine_embeds": "concat", "start_at": 0.0, "end_at": 1.0, "embeds_scaling": "V only"}, "class_type": "IPAdapterAdvanced"},
        # Deliberately TALL rather than square. On a square canvas the bust framing kept coming back
        # as two portraits side by side; a 3:4 canvas simply has no room to lay two heads out
        # horizontally, which suppresses the duplication structurally instead of by prompt-wrangling.
        # Cropped back to a square below, since the HUD slot is square.
        "portrait_lat": {"inputs": {"width": 384, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "portrait_samp": {"inputs": {"seed": seed, "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["ipa_portrait", 0], "positive": ["portrait_pos", 0], "negative": ["portrait_neg", 0], "latent_image": ["portrait_lat", 0]}, "class_type": "KSampler"},
        "portrait_dec": {"inputs": {"samples": ["portrait_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"},
        "portrait_save": {"inputs": {"filename_prefix": f"player_portrait_{int(time.time()*1000)}", "images": ["portrait_dec", 0]}, "class_type": "SaveImage"},
    })

    # Fresh txt2img per pose, with two separate anchors doing two separate jobs instead of one
    # anchor trying to do both: ControlNet (OpenPose skeleton, hand-authored per pose above) forces
    # the actual limb positions, while IPAdapter carries identity/style from the reference image.
    # Plain img2img-from-reference alone proved to hold onto the reference's silhouette far too
    # stubbornly for the pose text to ever come through, even at denoise 0.95. A regional
    # ConditioningCombine for a head-only "no face" push was tried and made things much worse
    # (destabilized this 8-step Lightning model into "reference sheet" collages) - reverted in
    # favor of weighted emphasis, e.g. (no face visible:1.4), within the single prompt/negative.
    for i, pose_prompt in enumerate(pose_prompts):
        name = PLAYER_FRAME_NAMES[i]
        skeleton_filename = render_pose_skeleton(name)
        # Weight 0.75 rather than 0.6: the lower value let individual frames drift round to a front
        # view (the block pose especially, since a raised arm reads as front-facing), even with the
        # reference itself locked to the back view.
        payload[f"ipa_{name}"] = {"inputs": {"model": ["lora", 0], "ipadapter": ["ipa_loader", 1], "image": ["ref_crop", 0], "weight": 0.75, "weight_type": "linear", "combine_embeds": "concat", "start_at": 0.0, "end_at": 1.0, "embeds_scaling": "V only"}, "class_type": "IPAdapterAdvanced"}
        payload[f"{name}_lat"] = {"inputs": {"width": 768, "height": 768, "batch_size": 1}, "class_type": "EmptyLatentImage"}
        payload[f"{name}_pos"] = {"inputs": {"text": pose_prompt, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"}
        payload[f"{name}_pose_img"] = {"inputs": {"image": skeleton_filename}, "class_type": "LoadImage"}
        payload[f"{name}_cn"] = {"inputs": {"positive": [f"{name}_pos", 0], "negative": ["neg", 0], "control_net": ["cn_loader", 0], "image": [f"{name}_pose_img", 0], "strength": 0.9, "start_percent": 0.0, "end_percent": 1.0}, "class_type": "ControlNetApplyAdvanced"}
        # ALL five frames share one seed. Rolling a fresh seed per frame meant each pose was an
        # independent render - different build, different framing, different shading - so switching
        # from idle to block looked like cutting to a different character rather than the same one
        # raising a shield. Same seed + same prompt scaffold means the ControlNet skeleton is the
        # only thing that varies between frames, which is exactly what an animation wants.
        payload[f"{name}_samp"] = {"inputs": {"seed": seed, "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": [f"ipa_{name}", 0], "positive": [f"{name}_cn", 0], "negative": [f"{name}_cn", 1], "latent_image": [f"{name}_lat", 0]}, "class_type": "KSampler"}
        payload[f"{name}_dec"] = {"inputs": {"samples": [f"{name}_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"}
        payload[f"{name}_mask"] = {"inputs": {"bg_removal_model": ["bg_model", 0], "image": [f"{name}_dec", 0]}, "class_type": "RemoveBackground"}
        payload[f"{name}_maskinv"] = {"inputs": {"mask": [f"{name}_mask", 0]}, "class_type": "InvertMask"}
        payload[f"{name}_save"] = {"inputs": {"filename_prefix": f"player_{name}_{int(time.time()*1000)}", "images": [f"{name}_dec", 0], "mask": [f"{name}_maskinv", 0]}, "class_type": "SaveImageWithAlpha"}

    data = json.dumps({"prompt": payload}).encode("utf-8")
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        prompt_id = json.loads(resp.read().decode("utf-8"))["prompt_id"]

    expected_saves = [f"{name}_save" for name in PLAYER_FRAME_NAMES] + ["sword_save", "shield_save", "portrait_save"]
    start_time = time.time()
    while time.time() - start_time < 300:
        time.sleep(0.2)
        hist_req = urllib.request.Request(f"{COMFY_URL}/history/{prompt_id}")
        with urllib.request.urlopen(hist_req) as h_resp:
            hist_data = json.loads(h_resp.read().decode("utf-8"))
            if prompt_id in hist_data:
                outputs = hist_data[prompt_id].get("outputs", {})
                if all(key in outputs for key in expected_saves):
                    def _path_of(key):
                        img_info = outputs[key]["images"][0]
                        return os.path.join(COMFY_OUTPUT_DIR, img_info.get("subfolder", ""), img_info["filename"])

                    sword_path = extract_single_sword(_path_of("sword_save"))
                    shield_path = extract_single_shield(_path_of("shield_save"))

                    # Composite BEFORE cropping: the anchor points are in the same normalized space
                    # as the pose skeletons, which only lines up on the full uncropped canvas.
                    frame_paths = []
                    for name in PLAYER_FRAME_NAMES:
                        path = _path_of(f"{name}_save")
                        # Drop any stray second figure BEFORE the gear goes on, so the shared
                        # bounding box below is measured against the player alone.
                        keep_largest_figure(path)
                        composite_gear_onto_frame(path, sword_path, shield_path, name)
                        frame_paths.append(path)

                    # One shared bbox for all five, so only the limbs move between frames. Cropping
                    # each frame to its own tight box made the character visibly resize and hop on
                    # every swap, since the frontend derives sprite width from each image's own
                    # aspect ratio against a fixed height.
                    crop_frames_to_common_bbox(frame_paths)

                    portrait_path = _path_of("portrait_save")
                    crop_portrait_square(portrait_path)

                    print(f"[Player Sprite] IPAdapter 5-frame set + composited gear + portrait complete for '{player_style}'")
                    return frame_paths, portrait_path

    raise TimeoutError("SDXL-Lightning + IPAdapter player sprite generation timed out.")


def _isolate_component(img_path, elongated):
    """Cut one object out of a generated item image and return it as a tight RGBA crop.

    Asking for "a single sword" reliably comes back as a whole weapon-asset SHEET instead - a grid
    of a dozen swords, sometimes with a shield thrown in - because that is overwhelmingly what item
    art looks like in the training data. Rather than fight the prompt, take it at face value and
    pick one object out of it with connected-component analysis, which works whether the model
    returned 1 item or 20.

    Shape is judged by PCA elongation rather than bounding-box aspect, because the model draws
    items at whatever angle it likes - a sideways sword has a WIDE bbox and would sail straight
    past any "tall and thin" test, which is how a shield once got picked as the sword."""
    import numpy as np
    from scipy import ndimage
    from PIL import Image

    arr = np.array(Image.open(img_path).convert("RGBA"))
    labels, n = ndimage.label(arr[:, :, 3] > 20)
    if n == 0:
        return None, None

    all_comps, shaped = [], []
    for idx, (sl_y, sl_x) in enumerate(ndimage.find_objects(labels)):
        label_id = idx + 1
        ys, xs = np.nonzero(labels[sl_y, sl_x] == label_id)
        filled = len(ys)
        if filled < 400:
            continue
        coords = np.stack([xs, ys]).astype(np.float64)
        coords -= coords.mean(axis=1, keepdims=True)
        evals, evecs = np.linalg.eigh(np.cov(coords))
        evals = np.maximum(evals, 1e-6)
        elong = float(np.sqrt(evals[1] / evals[0]))
        major = evecs[:, 1]

        # How many separate horizontal runs does a typical row of this component have? One real
        # sword answers 1. Several parallel swords whose hilts happen to touch answer 2, 3, 4 - and
        # that group can easily be the largest "elongated" component on the sheet, which is how a
        # cluster of blades kept getting picked and composited into the frame as one lumpy weapon.
        sub = labels[sl_y, sl_x] == label_id
        occupied = sub.any(axis=1)
        run_starts = (np.diff(sub.astype(np.int8), axis=1) == 1).sum(axis=1) + sub[:, 0]
        runs = float(np.median(run_starts[occupied])) if occupied.any() else 99.0

        entry = (label_id, sl_y, sl_x, filled, elong, major, runs)
        all_comps.append(entry)
        # A sword is a long thin bar; a shield is a compact ROUND slab. Both reject stray specks and
        # hairline slivers of leftover antialiasing. The shield's solidity is bounded at BOTH ends,
        # because a disc fills about 0.79 of its bounding box and the two failure modes sit either
        # side of that: the decorated rims the model likes to draw come out as hollow rings nearer
        # 0.3 (a hoop on the arm), while a contact sheet of shields packed edge to edge forms one
        # near-solid RECTANGLE approaching 1.0 (a tiled slab on the arm).
        solidity = filled / float(max(1, sub.shape[0] * sub.shape[1]))
        shape_ok = (2.2 < elong < 12.0) if elongated else (elong < 1.9 and 0.55 < solidity < 0.90)
        if shape_ok:
            shaped.append(entry)

    # Degrade gracefully rather than bailing out: returning None here would leave the caller
    # compositing the ENTIRE untouched sheet into every frame - that is the "fan of swords" bug.
    pool = shaped or all_comps
    if not pool:
        return None, None

    # Sort single-run components ahead of clusters FIRST, then take the beefiest of those - a
    # bulky blade reads best once scaled to sprite size, where a spindly one would vanish. Ranking
    # on size alone let a fused group of parallel blades win whenever it outweighed every clean
    # single sword on the sheet, which is how a fan of swords kept ending up in the player's hand.
    label_id, sl_y, sl_x, _, _, major, _ = max(pool, key=lambda c: (c[6] <= 1.4, c[3]))
    crop = arr[sl_y, sl_x].copy()
    # Blank out any NEIGHBOURING item overlapping this bounding box.
    crop[:, :, 3] = np.where(labels[sl_y, sl_x] == label_id, crop[:, :, 3], 0)
    return Image.fromarray(crop), major


def _tight_crop(img):
    import numpy as np
    a = np.array(img)
    ys, xs = np.nonzero(a[:, :, 3] > 20)
    if not len(ys):
        return img
    return img.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))


def crop_portrait_square(portrait_path):
    """Square off the tall portrait for the square HUD slot, keeping the TOP of the frame - that
    is where the head sits in a head-and-shoulders bust, so cropping downward would behead it."""
    from PIL import Image
    try:
        img = Image.open(portrait_path).convert("RGB")
        if img.height > img.width:
            img.crop((0, 0, img.width, img.width)).save(portrait_path, format="PNG")
    except Exception as e:
        print(f"[Portrait Crop Error] {e}")


def keep_largest_figure(frame_path):
    """Erase everything in a background-removed frame except the biggest connected blob.

    The character pass occasionally renders a SECOND figure - a bystander off to one side - and
    BiRefNet, correctly, cuts them both out. That extra person then rides along in the sprite and
    turns up in the game standing next to the player. The player is always the dominant mass in
    frame, so keeping only the largest component removes the intruder without touching them."""
    import numpy as np
    from scipy import ndimage
    from PIL import Image
    try:
        img = Image.open(frame_path).convert("RGBA")
        arr = np.array(img)
        labels, n = ndimage.label(arr[:, :, 3] > 20)
        if n <= 1:
            return
        counts = np.bincount(labels.ravel())
        counts[0] = 0                     # index 0 is the transparent background
        arr[:, :, 3] = np.where(labels == counts.argmax(), arr[:, :, 3], 0)
        Image.fromarray(arr).save(frame_path, format="PNG")
    except Exception as e:
        print(f"[Keep Largest Figure Error] {e}")


def _pick_path(src):
    """Where an extracted item sprite is written. Deliberately NOT over the source sheet: keeping
    the raw generation lets a bad pick be diagnosed afterwards, and stops a re-run compounding one."""
    base, ext = os.path.splitext(src)
    return f"{base}_pick{ext}"


def extract_single_sword(sword_path):
    """Reduce whatever the sword pass produced to exactly one upright, grip-at-the-bottom blade,
    so PLAYER_SWORD_TRANSFORMS' angles always pivot about the grip with 0 degrees = held upright.
    Returns the path of the extracted sprite, or None if nothing usable was found."""
    import math
    from PIL import Image
    try:
        sword, major = _isolate_component(sword_path, elongated=True)
        if sword is None:
            return None

        # Stand the blade upright along its own principal axis. The axis is a line, so its sign is
        # ambiguous - rotate both ways and keep whichever comes out actually vertical, which sidesteps
        # having to reason about PIL's rotation direction against image-space y-down coordinates.
        r = 90.0 - math.degrees(math.atan2(major[1], major[0]))
        best = None
        for angle in (r, -r):
            cand = _tight_crop(sword.rotate(angle, resample=Image.BICUBIC, expand=True))
            score = cand.height / max(1, cand.width)
            if best is None or score > best[0]:
                best = (score, cand)
        sword = best[1]

        # Find the crossguard and put it in the bottom half, which lands the sword grip-down.
        #
        # Not simply "the widest row": on a sword with a broad blade the widest row IS the blade,
        # which flips the whole thing point-down. What actually distinguishes a crossguard is that
        # it's a narrow SPIKE in the width profile - abruptly wider than the blade above it and the
        # grip below it - whereas a blade is wide but locally uniform. So score each row against a
        # rolling median of its own neighbourhood and take the sharpest outlier.
        import numpy as np
        from scipy.ndimage import median_filter
        widths = (np.array(sword)[:, :, 3] > 20).sum(axis=1).astype(float)
        n = len(widths)
        if n > 8:
            k = max(3, n // 12)
            ratio = widths / np.maximum(median_filter(widths, size=2 * k + 1, mode="nearest"), 1.0)
            # Ignore the extreme ends, where the rolling window is degenerate and a taper to a
            # point can masquerade as a spike.
            interior = np.zeros(n, dtype=bool)
            interior[int(n * 0.08):int(n * 0.92)] = True
            if int(np.argmax(np.where(interior, ratio, 0.0))) < n / 2:
                sword = sword.transpose(Image.ROTATE_180)

        out = _pick_path(sword_path)
        sword.save(out, format="PNG")
        return out
    except Exception as e:
        print(f"[Sword Extract Error] {e}")
        return None


def extract_single_shield(shield_path):
    """Reduce the shield pass to one compact roundish shield. No rotation normalising needed -
    a shield reads fine at any roll angle, unlike a blade.
    Returns the path of the extracted sprite, or None if nothing usable was found."""
    try:
        shield, _ = _isolate_component(shield_path, elongated=False)
        if shield is None:
            return None
        out = _pick_path(shield_path)
        shield.save(out, format="PNG")
        return out
    except Exception as e:
        print(f"[Shield Extract Error] {e}")
        return None


def _paste_pivoted(frame, sprite, cfg, anchor, pivot_bottom):
    """Scale, rotate and paste one gear sprite onto a frame at a normalized anchor point.
    `pivot_bottom` rotates about the sprite's bottom-centre (a sword swinging from its grip);
    otherwise it rotates about its own centre (a shield strapped flat to the forearm)."""
    from PIL import Image
    fw, fh = frame.size
    target_h = max(8, int(cfg["scale"] * fh))
    target_w = max(1, int(sprite.width * (target_h / sprite.height)))
    sprite = sprite.resize((target_w, target_h), Image.LANCZOS)

    # PIL rotates about the canvas centre, so park the desired pivot at the centre of a square
    # scratch canvas and that point becomes the pivot.
    pad = max(target_h, target_w) * 2
    scratch = Image.new("RGBA", (pad, pad), (0, 0, 0, 0))
    top = pad // 2 - target_h if pivot_bottom else pad // 2 - target_h // 2
    scratch.paste(sprite, (pad // 2 - target_w // 2, top), sprite)
    scratch = scratch.rotate(cfg["angle"], resample=Image.BICUBIC, center=(pad // 2, pad // 2))

    ox, oy = cfg.get("offset", (0.0, 0.0))
    layer = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    layer.paste(scratch, (int((anchor[0] + ox) * fw) - pad // 2,
                          int((anchor[1] + oy) * fh) - pad // 2), scratch)
    return Image.alpha_composite(frame, layer)


def _draw_swipe_streak(frame, streak):
    """Draw Valbrace's white swipe arc: a tapered crescent tracing where the blade travelled,
    thickest mid-swing and thinning to nothing at both ends."""
    import math
    from PIL import Image, ImageDraw, ImageFilter
    fw, fh = frame.size
    pts = [(x * fw, y * fh) for (x, y) in streak["points"]]
    max_r = max(2.0, streak["width"] * fw / 2.0)

    # Sample a Catmull-Rom spline through the control points and stamp a dot whose radius follows a
    # sine envelope. Both halves matter: a constant-width line read as a solid white bar bolted to
    # the sprite, and straight segments between the control points kinked into a lightning bolt.
    ctrl = [pts[0]] + pts + [pts[-1]]

    def sample(t):
        s = t * (len(ctrl) - 3)
        i = min(int(s), len(ctrl) - 4)
        f = s - i
        p0, p1, p2, p3 = ctrl[i], ctrl[i + 1], ctrl[i + 2], ctrl[i + 3]
        f2, f3 = f * f, f * f * f
        return tuple(
            0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * f
                   + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * f2
                   + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * f3)
            for d in (0, 1)
        )

    glow = Image.new("RGBA", (fw, fh), (255, 255, 255, 0))
    core = Image.new("RGBA", (fw, fh), (255, 255, 255, 0))
    gd, cd = ImageDraw.Draw(glow), ImageDraw.Draw(core)
    for k in range(160):
        t = k / 159.0
        x, y = sample(t)
        r = max_r * (math.sin(math.pi * t) ** 0.55)
        gd.ellipse([x - r * 2.4, y - r * 2.4, x + r * 2.4, y + r * 2.4], fill=(255, 255, 255, 26))
        cd.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 215))

    glow = glow.filter(ImageFilter.GaussianBlur(radius=max_r * 1.6))
    return Image.alpha_composite(Image.alpha_composite(frame, glow), core)


def composite_gear_onto_frame(frame_path, sword_path, shield_path, pose_name):
    """Bake the shared sword and shield sprites (and, on the slash, the motion streak) into one
    pose frame. Both are pinned to the very same wrist keypoints ControlNet used to place the arms,
    so the gear and the hands can never drift out of sync the way separate overlay layers did."""
    from PIL import Image
    try:
        kps = PLAYER_POSE_KEYPOINTS[pose_name]
        frame = Image.open(frame_path).convert("RGBA")

        # ALL gear is assembled on its own layer and slid UNDER the character. The camera sits
        # behind the player and the player faces away into the scene, so anything held out toward
        # the enemy - shield, blade, and the swipe arc the blade traced - is on the player's FAR
        # side. It belongs partly hidden behind their own silhouette, with only what clears the
        # body edge visible. Drawn on top, the sword read as being held behind the player's back.
        gear = Image.new("RGBA", frame.size, (0, 0, 0, 0))

        shield_cfg = PLAYER_SHIELD_TRANSFORMS.get(pose_name)
        if shield_cfg and kps[7] and shield_path and os.path.exists(shield_path):
            gear = _paste_pivoted(gear, Image.open(shield_path).convert("RGBA"),
                                  shield_cfg, kps[7], pivot_bottom=False)

        cfg = PLAYER_SWORD_TRANSFORMS.get(pose_name)
        if cfg and cfg.get("streak"):
            gear = _draw_swipe_streak(gear, cfg["streak"])

        if cfg and kps[4] and sword_path and os.path.exists(sword_path):
            gear = _paste_pivoted(gear, Image.open(sword_path).convert("RGBA"),
                                  cfg, kps[4], pivot_bottom=True)

        Image.alpha_composite(gear, frame).save(frame_path, format="PNG")
    except Exception as e:
        print(f"[Gear Composite Error] {pose_name}: {e}")


def crop_frames_to_common_bbox(frame_paths, pad=6):
    """Crop every frame to the UNION of all their alpha bounding boxes, so all frames come out the
    same size and the character holds still between swaps instead of rescaling each time."""
    import numpy as np
    from PIL import Image
    try:
        imgs = [Image.open(p).convert("RGBA") for p in frame_paths]
        boxes = []
        for img in imgs:
            ys, xs = np.where(np.array(img)[:, :, 3] > 20)
            if len(ys):
                boxes.append((xs.min(), ys.min(), xs.max(), ys.max()))
        if not boxes:
            return
        w, h = imgs[0].size
        x1 = max(0, min(b[0] for b in boxes) - pad)
        y1 = max(0, min(b[1] for b in boxes) - pad)
        x2 = min(w, max(b[2] for b in boxes) + pad)
        y2 = min(h, max(b[3] for b in boxes) + pad)
        for img, path in zip(imgs, frame_paths):
            img.crop((x1, y1, x2, y2)).save(path, format="PNG")
    except Exception as e:
        print(f"[Common Bbox Crop Error] {e}")

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



def generate_flux_all_assets(wall_style, player_style=None, player_image_b64=None, mode="v4_flux", progress_cb=None):
    """Generate Dungeon Textures (Wall, Ceil, Floor) + AI Face Portrait + Player Character Sprite in FLUX."""
    prefix_w = f"trio_w_{int(time.time()*1000)}"
    prefix_c = f"trio_c_{int(time.time()*1000)}"
    prefix_f = f"trio_f_{int(time.time()*1000)}"
    prefix_p = f"player_{int(time.time()*1000)}"
    prefix_face = f"face_{int(time.time()*1000)}"
    
    wall_p, ceil_p, floor_p = get_surface_prompts(wall_style)

    # v4_flux with no attached reference photo uses the separate SDXL-Lightning + IPAdapter
    # pipeline (generate_player_sprite_ipadapter) for consistent multi-frame character sprites
    # instead of the single-image FLUX branch below.
    use_ipadapter_sprites = (mode == "v4_flux") and not (player_image_b64 and "," in player_image_b64)

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
    elif mode == "v4_flux":
        p_style = player_style.strip() if (player_style and player_style.strip()) else "armored knight"
        portrait_prompt = f"Close-up front view video game portrait of a heroic {p_style} warrior, Doom status portrait style, atmospheric dungeon lighting."
        player_prompt = (
            f"2D game asset sprite sheet, 4 distinct widely spaced animation frames in a single horizontal row on a pure solid white background. "
            f"Character seen strictly directly from behind in third-person back view, 0 degree angle facing away from camera towards the front. "
            f"Frame 1: {p_style} warrior standing idle holding sword. "
            f"Frame 2: {p_style} warrior blocking with shield held forward facing away towards the front to block incoming attacks. "
            f"Frame 3: {p_style} warrior winding up sword high overhead. "
            f"Frame 4: {p_style} warrior executing an upward rising vertical sword slash arc. "
            f"Photorealistic 3D game render, highly detailed textures, Unreal Engine 5 aesthetic."
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

        # AI Face Portrait (Front View)
        "face_lat": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "face_pos": {"inputs": {"text": portrait_prompt, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        "face_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["face_pos", 0], "negative": ["neg", 0], "latent_image": ["face_lat", 0]}, "class_type": "KSampler"},
        "face_dec": {"inputs": {"samples": ["face_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
        "face_save": {"inputs": {"filename_prefix": prefix_face, "images": ["face_dec", 0]}, "class_type": "SaveImage"}
    }

    if not use_ipadapter_sprites:
        # Single-image player branch (used only when a reference photo is attached, or for
        # non-v4_flux modes). The v4_flux/no-photo case generates its sprite separately below.
        prompt_payload["p_lat"] = {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"}
        prompt_payload["p_pos"] = {"inputs": {"text": player_prompt, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"}
        prompt_payload["p_samp"] = {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["p_pos", 0], "negative": ["neg", 0], "latent_image": ["p_lat", 0]}, "class_type": "KSampler"}
        prompt_payload["p_dec"] = {"inputs": {"samples": ["p_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"}
        prompt_payload["p_save"] = {"inputs": {"filename_prefix": prefix_p, "images": ["p_dec", 0]}, "class_type": "SaveImage"}

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
                required_saves = ["w_save", "c_save", "f_save", "face_save"] + ([] if use_ipadapter_sprites else ["p_save"])
                if all(key in outputs for key in required_saves):
                    w_img = outputs["w_save"]["images"][0]["filename"]
                    c_img = outputs["c_save"]["images"][0]["filename"]
                    f_img = outputs["f_save"]["images"][0]["filename"]
                    face_img = outputs["face_save"]["images"][0]["filename"]

                    w_sub = outputs["w_save"]["images"][0].get("subfolder", "")
                    c_sub = outputs["c_save"]["images"][0].get("subfolder", "")
                    f_sub = outputs["f_save"]["images"][0].get("subfolder", "")
                    face_sub = outputs["face_save"]["images"][0].get("subfolder", "")

                    w_path = os.path.join(COMFY_OUTPUT_DIR, w_sub, w_img)
                    c_path = os.path.join(COMFY_OUTPUT_DIR, c_sub, c_img)
                    f_path = os.path.join(COMFY_OUTPUT_DIR, f_sub, f_img)
                    face_path = os.path.join(COMFY_OUTPUT_DIR, face_sub, face_img)

                    make_seamless_4way(w_path, blend_pixels=12)
                    make_seamless_4way(c_path, blend_pixels=12)
                    make_seamless_4way(f_path, blend_pixels=12)
                    if use_ipadapter_sprites:
                        if progress_cb:
                            progress_cb("Rigging Character Animation Frames (SDXL-Lightning + IPAdapter)...", 65)
                        # Prefer the sprite pipeline's own portrait - it shares the character's
                        # IPAdapter reference, so it actually looks like the player, unlike the
                        # FLUX portrait generated independently up in the texture batch.
                        p_frames, portrait_path = generate_player_sprite_ipadapter(player_style)
                        return w_path, c_path, f_path, p_frames, (portrait_path or face_path)
                    else:
                        p_img = outputs["p_save"]["images"][0]["filename"]
                        p_sub = outputs["p_save"]["images"][0].get("subfolder", "")
                        p_path = os.path.join(COMFY_OUTPUT_DIR, p_sub, p_img)
                        make_sprite_transparent(p_path)
                        return w_path, c_path, f_path, p_path, face_path

    raise TimeoutError("FLUX.1 Dungeon, Player & Portrait generation timed out.")


def run_batch_v3_flux(wall_style, player_style=None, player_image=None, mode="v4_flux"):
    """v3 FLUX.1 [schnell] mode: Generates 3 Dungeon Surfaces + 1 Player Character Sprite + 1 AI Face Portrait."""
    global gen_progress
    gen_progress["is_generating"] = True
    gen_progress["completed_bundle"] = None
    gen_progress["error"] = None
    gen_progress["current_step"] = 0
    gen_progress["total_steps"] = 2

    def _progress(msg, percent):
        gen_progress["status_message"] = msg
        gen_progress["percent"] = percent

    try:
        gen_progress["current_step"] = 1
        gen_progress["status_message"] = "Synthesizing Dungeon Textures & AI Portrait with FLUX.1 [schnell]..."
        gen_progress["percent"] = 30

        w_path, c_path, f_path, p_res, face_path = generate_flux_all_assets(wall_style, player_style, player_image, mode=mode, progress_cb=_progress)

        gen_progress["current_step"] = 2
        gen_progress["status_message"] = "Assembling 3D World & Valbrace Combat..."
        gen_progress["percent"] = 90

        with open(w_path, "rb") as tf:
            w_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        with open(c_path, "rb") as tf:
            c_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        with open(f_path, "rb") as tf:
            f_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        p_sprites_b64 = []
        p_b64 = None
        if isinstance(p_res, list):
            for pf in p_res:
                with open(pf, "rb") as tf:
                    p_sprites_b64.append(f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}")
            p_b64 = p_sprites_b64[0]
        else:
            with open(p_res, "rb") as tf:
                p_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
            p_sprites_b64 = [p_b64]
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
            "player_sprites": p_sprites_b64,
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

            t = threading.Thread(target=run_batch_v3_flux, args=(wall_style, player_style, player_image, mode), daemon=True)
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
