#!/usr/bin/env bash
# Generate O3C notification voice clips using Azure Speech (Nigerian English neural
# voices: en-NG-EzinneNeural female / en-NG-AbeoNeural male). These are the same
# high-quality voices Edge exposes, but rendered server-side to static files so the
# app plays them consistently in every browser.
#
# This one CAN be run from the workspace server (only needs curl + an Azure Speech key
# on the free tier). Output drops straight into the app.
#
#   AZURE_SPEECH_KEY=xxxxx AZURE_SPEECH_REGION=eastus ./generate_clips_azure.sh
#
# Output: ../../frontend/public/notif-audio/<key>_female.mp3, _male.mp3, manifest.json
set -euo pipefail

: "${AZURE_SPEECH_KEY:?set AZURE_SPEECH_KEY}"
: "${AZURE_SPEECH_REGION:?set AZURE_SPEECH_REGION (e.g. eastus)}"

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../frontend/public/notif-audio"
PHRASES="$HERE/phrases.json"
ENDPOINT="https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"
FEMALE_VOICE="en-NG-EzinneNeural"
MALE_VOICE="en-NG-AbeoNeural"

mkdir -p "$OUT"

# keys (exclude _comment)
KEYS=$(grep -oE '"[a-z_]+"[[:space:]]*:' "$PHRASES" | tr -d '":' | tr -d ' ' | grep -v '^_comment$')

synth () { # $1=voice $2=text $3=outfile
  local ssml="<speak version='1.0' xml:lang='en-NG'><voice name='$1'>$2</voice></speak>"
  curl -s --fail -X POST "$ENDPOINT" \
    -H "Ocp-Apim-Subscription-Key: ${AZURE_SPEECH_KEY}" \
    -H "Content-Type: application/ssml+xml" \
    -H "X-Microsoft-OutputFormat: audio-24khz-96kbitrate-mono-mp3" \
    -H "User-Agent: o3c-notif" \
    --data "$ssml" -o "$3"
  echo "  wrote $3"
}

for key in $KEYS; do
  # extract the phrase for this key from phrases.json
  text=$(grep -oE "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$PHRASES" | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
  echo "$key -> $text"
  synth "$FEMALE_VOICE" "$text" "$OUT/${key}_female.mp3"
  synth "$MALE_VOICE"   "$text" "$OUT/${key}_male.mp3"
done

# manifest
printf '{ "keys": [%s], "voices": ["female","male"], "source": "azure", "female": "%s", "male": "%s" }\n' \
  "$(echo $KEYS | sed -E 's/([a-z_]+)/"\1"/g; s/ /,/g')" "$FEMALE_VOICE" "$MALE_VOICE" \
  > "$OUT/manifest.json"

echo "Done. Clips + manifest written to $OUT"
