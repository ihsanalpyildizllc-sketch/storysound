// netlify/functions/preview-audio.js
//
// Serves ~20 seconds of the song and nothing more. The slice is taken from
// roughly a third of the way in, which on Suno output lands on the chorus —
// where the recipient's name is sung. The intro is instrumental and sells nothing.
//
// No ffmpeg: we slice MP3 frames directly, so there is no new build dependency.
// GET /.netlify/functions/preview-audio?o=<orderId>

const CLIP_SECONDS = 60;
const HOOK_AT = 0;             // start from the beginning
const MIN_START_SECONDS = 0;   // no skip

/* ── minimal MP3 frame walker: gives us real frame boundaries + duration ──── */
const BITRATES_V1L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const BITRATES_V2L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
const RATES_V1 = [44100,48000,32000,0];
const RATES_V2 = [22050,24000,16000,0];

function frames(buf) {
  const list = [];
  let i = 0;

  // skip ID3v2
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "ID3") {
    i = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  }

  while (i < buf.length - 4) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }

    const verBits = (buf[i + 1] >> 3) & 0x03;      // 3 = MPEG1, 2 = MPEG2
    const layer   = (buf[i + 1] >> 1) & 0x03;      // 1 = Layer III
    if (layer !== 1 || verBits === 1) { i++; continue; }

    const mpeg1 = verBits === 3;
    const br = (mpeg1 ? BITRATES_V1L3 : BITRATES_V2L3)[(buf[i + 2] >> 4) & 0x0f];
    const sr = (mpeg1 ? RATES_V1 : RATES_V2)[(buf[i + 2] >> 2) & 0x03];
    if (!br || !sr) { i++; continue; }

    const pad = (buf[i + 2] >> 1) & 0x01;
    const spf = mpeg1 ? 1152 : 576;
    const len = Math.floor((spf / 8) * br * 1000 / sr) + pad;
    if (len < 24) { i++; continue; }

    list.push({ offset: i, length: len, seconds: spf / sr });
    i += len;
  }
  return list;
}

exports.handler = async (event) => {
  const orderId = (event.queryStringParameters || {}).o
              || (event.queryStringParameters || {}).orderId;
  if (!orderId) return { statusCode: 400, body: "missing order id" };

  try {
    const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/song_${orderId}`, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const raw = (await res.json())?.result;
    if (!raw) return { statusCode: 404, body: "not found" };

    const song = JSON.parse(raw);
    if (!song.audio_b64) return { statusCode: 409, body: "not ready" };

    const buf = Buffer.from(song.audio_b64, "base64");
    const fr = frames(buf);

    // malformed / unparsable: fall back to a byte estimate rather than leaking the file
    if (fr.length < 40) {
      const approx = Math.min(buf.length, 16000 * CLIP_SECONDS);   // ~128kbps
      return audio(buf.subarray(0, approx), event);
    }

    const total = fr.reduce((a, f) => a + f.seconds, 0);
    let startAt = Math.max(MIN_START_SECONDS, total * HOOK_AT);
    if (startAt + CLIP_SECONDS > total) startAt = Math.max(0, total - CLIP_SECONDS);

    let acc = 0, from = 0, to = fr.length - 1;
    for (let k = 0; k < fr.length; k++) {
      if (acc <= startAt) from = k;
      if (acc <= startAt + CLIP_SECONDS) to = k;
      acc += fr[k].seconds;
    }

    const startByte = fr[from].offset;
    const endByte = fr[to].offset + fr[to].length;
    return audio(buf.subarray(startByte, endByte), event);
  } catch (err) {
    console.error("preview-audio:", err);
    return { statusCode: 500, body: "preview failed" };
  }
};

function audio(slice, event) {
  const total = slice.length;
  const rangeHeader = (event && (event.headers["range"] || event.headers["Range"])) || "";

  // Safari (and all mobile browsers) REQUIRE a proper 206 Partial Content response
  // when they send a Range request. Returning 200 causes MEDIA_ERR_SRC_NOT_SUPPORTED.
  if (rangeHeader && rangeHeader.startsWith("bytes=")) {
    const [rawStart, rawEnd] = rangeHeader.slice(6).split("-");
    const start = parseInt(rawStart) || 0;
    const end   = rawEnd ? Math.min(parseInt(rawEnd), total - 1) : total - 1;
    const chunk = slice.subarray(start, end + 1);
    return {
      statusCode: 206,
      headers: {
        "Content-Type":   "audio/mpeg",
        "Content-Range":  `bytes ${start}-${end}/${total}`,
        "Content-Length": String(chunk.length),
        "Accept-Ranges":  "bytes",
        "Cache-Control":  "public, max-age=600",
        "Access-Control-Allow-Origin": "*"
      },
      body: chunk.toString("base64"),
      isBase64Encoded: true
    };
  }

  // No Range header — return full clip (Chromium / initial load)
  return {
    statusCode: 200,
    headers: {
      "Content-Type":   "audio/mpeg",
      "Content-Length": String(total),
      "Accept-Ranges":  "bytes",
      "Cache-Control":  "public, max-age=600",
      "Access-Control-Allow-Origin": "*"
    },
    body: slice.toString("base64"),
    isBase64Encoded: true
  };
}
