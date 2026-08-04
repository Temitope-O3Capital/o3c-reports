# Notification voice clips

The notification bell plays a recorded human **Nigerian** voice per notification when a
user opts in (bell → Voice → Female/Male). Drop the generated audio here:

```
notif-audio/
  manifest.json          # { "keys": [...], "voices": ["female","male"] }
  default_female.mp3      default_male.mp3
  card_cycle_risk_female.mp3  card_cycle_risk_male.mp3
  ... one pair per key in tools/tts/phrases.json
```

- Files are served same-origin at `/notif-audio/...` (CSP-safe), so the app needs **no
  runtime TTS** — it just plays these static clips.
- The player (`frontend/src/lib/notifyEffects.ts`) reads `manifest.json`; if it's absent
  or a specific clip fails, it **falls back to the browser voice**. So the app works with
  or without these files.

## Generate the clips (run once, off the app server)

Pick one — both live in `tools/tts/`:

1. **YarnGPT** (open-source, Apache-2.0, Nigerian-accented English) —
   `generate_clips_yarngpt.py`. Run on free Google Colab (GPU), then copy the output
   `notif-audio/` folder here.
2. **Azure Speech** (`en-NG-EzinneNeural` / `en-NG-AbeoNeural`) —
   `generate_clips_azure.sh`. Runnable from the workspace server with an Azure Speech
   key: `AZURE_SPEECH_KEY=... AZURE_SPEECH_REGION=eastus ./generate_clips_azure.sh`.

After dropping files in, rebuild the frontend and redeploy. Done.
