import os
import json
import folder_paths
import comfy.lora
import comfy.utils


class PowerLTXLoraLoaderExtra:
    @classmethod
    def INPUT_TYPES(s):
        lora_list = ["None"] + folder_paths.get_filename_list("loras")
        return {
            "required": {
                # lora_data is managed entirely by the JS frontend via
                # node.properties — the hidden widget bridges data to Python.
                "lora_data": ("STRING", {"default": "[]", "multiline": False}),
            },
            "optional": {
                # Model is optional — the node can still output lora_data
                # JSON even when no model is connected.
                "model": ("MODEL",),
            },
            "hidden": {"available_loras": (lora_list,)}
        }

    RETURN_TYPES = ("MODEL", "STRING")
    RETURN_NAMES = ("model", "lora_data")
    FUNCTION = "load_loras"
    CATEGORY = "loaders"

    # ─────────────────────────────────────────────
    #  Helper: Build rich LoRA info list
    # ─────────────────────────────────────────────

    @staticmethod
    def _build_lora_info(data):
        """
        Build a list of rich LoRA info dicts from raw row data.

        Includes every row that has a LoRA selected (lora != "None"),
        regardless of whether it is enabled or disabled.  Each dict
        carries an ``enabled`` flag so consumers can filter as needed.

        Returns:
            list[dict]: One entry per selected LoRA with keys:
                name, path, enabled, strength_model, video,
                video_to_audio, audio, audio_to_video, other, metadata
        """
        result = []
        for row in data:
            lora_name = row.get("lora")
            if not lora_name or lora_name == "None":
                continue

            full_path = folder_paths.get_full_path("loras", lora_name)

            # Fetch sidecar metadata (.json) if it exists next to the weights file
            info_data = {}
            if full_path:
                info_file = os.path.splitext(full_path)[0] + ".json"
                if os.path.exists(info_file):
                    try:
                        with open(info_file, "r", encoding="utf-8") as f:
                            info_data = json.load(f)
                    except Exception:
                        pass

            result.append({
                "name":            lora_name,
                "path":            full_path,
                "enabled":         bool(row.get("on", True)),
                "strength_model":  float(row.get("str", 1.0)),
                "video":           float(row.get("vid", 1.0)),
                "video_to_audio":  float(row.get("v2a", 1.0)),
                "audio":           float(row.get("aud", 1.0)),
                "audio_to_video":  float(row.get("a2v", 1.0)),
                "other":           float(row.get("other", 1.0)),
                "metadata":        info_data,
            })
        return result

    # ─────────────────────────────────────────────
    #  Public API: loras()
    # ─────────────────────────────────────────────

    @classmethod
    def loras(cls, prompt_node: dict):
        """
        Returns a list of rich LoRA dicts for every LoRA that has been
        selected in the UI (lora != "None").  Each entry includes an
        ``enabled`` field so callers can distinguish active vs. disabled
        entries.  Useful for external scripts parsing the prompt dictionary.
        """
        lora_data_str = prompt_node.get("inputs", {}).get("lora_data", "[]")
        try:
            data = json.loads(lora_data_str)
        except Exception:
            return []
        return cls._build_lora_info(data)

    # ─────────────────────────────────────────────
    #  Main Execution
    # ─────────────────────────────────────────────

    def load_loras(self, lora_data, model=None, available_loras=None):
        """
        Applies every active LoRA to the model and returns both the
        patched model and a JSON string of rich LoRA info (for the
        lora_data output port).

        When no model is connected, LoRA loading is skipped but the
        lora_data JSON output is still produced.

        The JS frontend sends all rows that have a LoRA selected
        (lora != "None"), including disabled ones, so the lora_data
        output includes everything.  Only rows that are enabled with
        non-zero strength are applied to the model.
        """
        try:
            data = json.loads(lora_data)
        except Exception:
            return (model, "[]")

        # Build the rich info list for the STRING output
        lora_info_json = json.dumps(self._build_lora_info(data), indent=2)

        # If no model is connected, skip LoRA patching entirely
        if model is None:
            return (None, lora_info_json)

        # Clone model to prevent mutating previous nodes
        new_model = model.clone()

        for row in data:
            # Only apply LoRAs that are enabled, selected, and have non-zero strength
            if not row.get("on") or row.get("lora") == "None":
                continue
            if float(row.get("str", 1.0)) == 0:
                continue

            lora_name = row.get("lora")
            path = folder_paths.get_full_path("loras", lora_name)
            if not path:
                print(f"[PowerLTXLoraLoaderExtra] Warning: LoRA not found: {lora_name}")
                continue

            strength_model  = float(row.get("str", 1.0))
            video           = float(row.get("vid", 1.0))
            video_to_audio  = float(row.get("v2a", 1.0))
            audio           = float(row.get("aud", 1.0))
            audio_to_video  = float(row.get("a2v", 1.0))
            other           = float(row.get("other", 1.0))

            lora = comfy.utils.load_torch_file(path, safe_load=True)

            key_map = {}
            key_map = comfy.lora.model_lora_keys_unet(new_model.model, key_map)
            loaded = comfy.lora.load_lora(lora, key_map)

            keys_to_delete = []

            # Apply layer-based attention strength filtering (LTX2 specific)
            for key in list(loaded.keys()):
                key_str = key if isinstance(key, str) else (
                    key[0] if isinstance(key, tuple) else str(key)
                )
                strength_multiplier = None

                # Prioritised keyword matching for LTX2 attention layers
                if "video_to_audio_attn" in key_str:
                    strength_multiplier = video_to_audio
                elif "audio_to_video_attn" in key_str:
                    strength_multiplier = audio_to_video
                elif "audio_attn" in key_str or "audio_ff.net" in key_str:
                    strength_multiplier = audio
                elif "attn" in key_str or "ff.net" in key_str:
                    strength_multiplier = video
                else:
                    strength_multiplier = other

                # Apply multiplier to the alpha weights
                if strength_multiplier is not None:
                    if strength_multiplier == 0:
                        keys_to_delete.append(key)
                    elif strength_multiplier != 1.0:
                        value = loaded[key]
                        if hasattr(value, "weights"):
                            weights_list = list(value.weights)
                            current_alpha = (
                                weights_list[2]
                                if weights_list[2] is not None
                                else 1.0
                            )
                            weights_list[2] = current_alpha * strength_multiplier
                            loaded[key].weights = tuple(weights_list)

            for key in keys_to_delete:
                if key in loaded:
                    del loaded[key]

            new_model.add_patches(loaded, strength_model)

        return (new_model, lora_info_json)
