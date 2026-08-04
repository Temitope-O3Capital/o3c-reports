#!/usr/bin/env python3
"""
Generate O3C notification voice clips with YarnGPT (open-source, Apache-2.0,
Nigerian-accented English). Run this ONCE on a GPU box or free Google Colab, then
drop the output folder into frontend/public/notif-audio/.

Why not on the app server: YarnGPT is a ~0.4B-param LLM TTS needing Python + PyTorch
+ a GPU; the workspace server has none. This produces static clips so the app needs
no TTS at runtime — it just plays the recorded files (consistent for every browser).

Colab quickstart:
    !git clone https://github.com/saheedniyi02/yarngpt.git
    %cd yarngpt
    !pip install -q outetts uroman transformers torchaudio soundfile pydub
    !wget -q https://huggingface.co/novateur/WavTokenizer-large-speech-75token/resolve/main/wavtokenizer_large_speech_320_24k.ckpt
    !wget -q https://huggingface.co/novateur/WavTokenizer/resolve/main/wavtokenizer_mediumdata_frame75_3s_nq1_code1024_dim512_kmeans200_1_1.yaml
    # then run this script (adjust the two paths below to the downloaded files)

Voices: female -> 'idera' (the maintainer's recommended/best), male -> 'jude'.
Output: ./notif-audio/<key>_female.mp3, <key>_male.mp3, and manifest.json
"""

import json, os, pathlib

# --- config -----------------------------------------------------------------
OUT_DIR      = pathlib.Path("notif-audio")
PHRASES_FILE = pathlib.Path(__file__).with_name("phrases.json")
VOICE_FEMALE = "idera"
VOICE_MALE   = "jude"
# Point these at the WavTokenizer files you downloaded (see quickstart above):
WT_CONFIG = "wavtokenizer_mediumdata_frame75_3s_nq1_code1024_dim512_kmeans200_1_1.yaml"
WT_CKPT   = "wavtokenizer_large_speech_320_24k.ckpt"
HF_MODEL  = "saheedniyi/YarnGPT"
# ----------------------------------------------------------------------------

def main():
    import torch, torchaudio  # noqa
    from pydub import AudioSegment
    from yarngpt.audiotokenizer import AudioTokenizer
    from transformers import AutoModelForCausalLM

    phrases = {k: v for k, v in json.loads(PHRASES_FILE.read_text()).items()
               if not k.startswith("_")}
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    tokenizer = AudioTokenizer(HF_MODEL, WT_CKPT, WT_CONFIG)
    model = AutoModelForCausalLM.from_pretrained(HF_MODEL, torch_dtype="auto").to(
        "cuda" if torch.cuda.is_available() else "cpu")

    def synth(text, speaker, out_mp3):
        prompt = tokenizer.create_prompt(text, speaker)
        input_ids = tokenizer.tokenize_prompt(prompt)
        output = model.generate(input_ids=input_ids, temperature=0.1,
                                repetition_penalty=1.1, max_length=4000)
        codes = tokenizer.get_codes(output)
        audio = tokenizer.get_audio(codes)  # torch tensor @ 24kHz
        wav_tmp = str(out_mp3) + ".wav"
        torchaudio.save(wav_tmp, audio, sample_rate=24000)
        AudioSegment.from_wav(wav_tmp).export(out_mp3, format="mp3", bitrate="96k")
        os.remove(wav_tmp)
        print("  wrote", out_mp3)

    for key, text in phrases.items():
        print(key, "->", text)
        synth(text, VOICE_FEMALE, OUT_DIR / f"{key}_female.mp3")
        synth(text, VOICE_MALE,   OUT_DIR / f"{key}_male.mp3")

    (OUT_DIR / "manifest.json").write_text(json.dumps(
        {"keys": list(phrases.keys()), "voices": ["female", "male"],
         "source": "YarnGPT", "female": VOICE_FEMALE, "male": VOICE_MALE}, indent=2))
    print("\nDone. Copy the ./notif-audio folder into frontend/public/notif-audio/")

if __name__ == "__main__":
    main()
