from .power_ltx_lora_loader import PowerLTXLoraLoaderExtra

NODE_CLASS_MAPPINGS = {
    "PowerLTXLoraLoaderExtra": PowerLTXLoraLoaderExtra
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowerLTXLoraLoaderExtra": "Power LTX LoRA Loader Extra"
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
