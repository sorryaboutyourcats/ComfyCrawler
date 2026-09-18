"""ComfyCrawler as a ComfyUI custom node.

Installed into ComfyUI's custom_nodes, ComfyCrawler is served by ComfyUI itself at
http://127.0.0.1:8188/comfycrawler/ (on whatever port ComfyUI uses) and adds an "Open ComfyCrawler"
entry to ComfyUI's menu, an action-bar button and a sidebar panel (models, downloads, and a reload
for an updated checkout). It adds no nodes to the graph. The game is server.py - the same file the
standalone server (`python server.py`) runs - wired into ComfyUI by comfy_node.install.
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
# Only the menu-button script lives here: ComfyUI loads every .js under this folder into its own
# page, so game.js must never be in it.
WEB_DIRECTORY = "./comfyui_web"


def _running_comfyui_server():
    """ComfyUI's PromptServer when this is being loaded by ComfyUI, else None. `server` here is
    ComfyUI's own module - ours is only ever imported relatively, as `.server`."""
    try:
        from server import PromptServer
    except Exception:
        return None
    return getattr(PromptServer, "instance", None)


_prompt_server = _running_comfyui_server()
if _prompt_server is not None:
    from . import comfy_node
    from . import server as _comfycrawler_server

    comfy_node.install(_comfycrawler_server, _prompt_server)
