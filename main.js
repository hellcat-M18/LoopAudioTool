// ===== ログ表示 =====
const logEl = document.getElementById("log");
function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

// ===== ゼロクロス探索 =====
function findNearestZeroCross(samples, targetIndex, searchRadius = 4000) {
  const n = samples.length;
  if (n < 2) return targetIndex;

  const start = Math.max(0, targetIndex - searchRadius);
  const end = Math.min(n - 2, targetIndex + searchRadius);

  let bestIndex = targetIndex;
  let bestDist = Infinity;

  for (let i = start; i <= end; i++) {
    const s1 = samples[i];
    const s2 = samples[i + 1];
    // 符号変化 or 0 をゼロクロスとして扱う
    if (s1 === 0 || s2 === 0 || (s1 > 0 && s2 < 0) || (s1 < 0 && s2 > 0)) {
      const idx = i;
      const dist = Math.abs(idx - targetIndex);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = idx;
      }
    }
  }
  return bestIndex;
}

// ===== 共通: AudioBuffer → モノラル Float32Array =====
function extractMonoSamples(buffer, startSample, endSample) {
  const numChannels = buffer.numberOfChannels;
  const length = endSample - startSample;
  const mono = new Float32Array(length);

  if (numChannels === 1) {
    const ch = buffer.getChannelData(0).subarray(startSample, endSample);
    mono.set(ch);
  } else {
    for (let ch = 0; ch < numChannels; ch++) {
      const data = buffer.getChannelData(ch).subarray(startSample, endSample);
      for (let i = 0; i < length; i++) {
        mono[i] += data[i] / numChannels;
      }
    }
  }
  return mono;
}

// ===== WAV エンコード (PCM16, mono) =====
function monoFloatToWavBlob(samples, sampleRate) {
  const length = samples.length;
  const pcm16 = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const byteRate = sampleRate * 2;
  const blockAlign = 2;
  const bufferLength = 44 + pcm16.length * 2;
  const ab = new ArrayBuffer(bufferLength);
  const view = new DataView(ab);

  function writeString(off, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(off + i, str.charCodeAt(i));
    }
  }

  let offset = 0;
  writeString(offset, "RIFF"); offset += 4;
  view.setUint32(offset, 36 + pcm16.length * 2, true); offset += 4;
  writeString(offset, "WAVE"); offset += 4;
  writeString(offset, "fmt "); offset += 4;
  view.setUint32(offset, 16, true); offset += 4;          // Subchunk1Size
  view.setUint16(offset, 1, true); offset += 2;           // PCM
  view.setUint16(offset, 1, true); offset += 2;           // mono
  view.setUint32(offset, sampleRate, true); offset += 4;  // SampleRate
  view.setUint32(offset, byteRate, true); offset += 4;    // ByteRate
  view.setUint16(offset, blockAlign, true); offset += 2;  // BlockAlign
  view.setUint16(offset, 16, true); offset += 2;          // BitsPerSample
  writeString(offset, "data"); offset += 4;
  view.setUint32(offset, pcm16.length * 2, true); offset += 4;

  for (let i = 0; i < pcm16.length; i++, offset += 2) {
    view.setInt16(offset, pcm16[i], true);
  }

  return new Blob([ab], { type: "audio/wav" });
}

// ===== Ogg Vorbis エンコード =====
async function monoFloatToOggBlob(samples, sampleRate, quality) {
  if (typeof OggVorbisEncoder === "undefined") {
    throw new Error("OggVorbisEncoder が読み込まれていません。ライブラリ読み込みを確認してください。");
  }
  const encoder = new OggVorbisEncoder(sampleRate, 1, quality);
  encoder.encode([samples]);          // mono
  const oggData = encoder.finish();   // Uint8Array
  return new Blob([oggData], { type: "audio/ogg" });
}

// ===== MP3 エンコード (lamejs) =====
async function monoFloatToMp3Blob(samples, sampleRate) {
  if (typeof lamejs === "undefined") {
    throw new Error("lamejs が読み込まれていません。ライブラリ読み込みを確認してください。");
  }

  const Mp3Encoder = lamejs.Mp3Encoder;
  const mp3encoder = new Mp3Encoder(1, sampleRate, 128); // mono, 128kbps

  const pcm16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const mp3Data = [];
  const chunk = mp3encoder.encodeBuffer(pcm16);
  if (chunk.length > 0) mp3Data.push(chunk);
  const end = mp3encoder.flush();
  if (end.length > 0) mp3Data.push(end);

  return new Blob(mp3Data, { type: "audio/mpeg" });
}

// ===== 単一ファイル処理ロジック =====
async function processSingleFile(file, params) {
  const { startSec, endSec, searchRadius, outFormat, oggQuality } = params;

  log(`--- 処理開始: ${file.name} ---`);

  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new AudioContext();
  const buffer = await audioCtx.decodeAudioData(arrayBuffer);

  const sr = buffer.sampleRate;
  const rawStart = Math.max(
    0,
    Math.min(buffer.length - 1, Math.floor(startSec * sr))
  );
  const rawEnd = Math.max(
    0,
    Math.min(buffer.length - 1, Math.floor(endSec * sr))
  );

  const samplesCh0 = buffer.getChannelData(0);
  const startIdx = findNearestZeroCross(samplesCh0, rawStart, searchRadius);
  const endIdx = findNearestZeroCross(samplesCh0, rawEnd, searchRadius);

  if (endIdx <= startIdx) {
    log(`  [エラー] ${file.name}: ゼロクロス調整後に終点が始点より前になりました。`);
    return;
  }

  const adjStartSec = startIdx / sr;
  const adjEndSec = endIdx / sr;

  log(`  指定範囲: ${startSec.toFixed(3)}s - ${endSec.toFixed(3)}s`);
  log(`  調整後  : ${adjStartSec.toFixed(3)}s - ${adjEndSec.toFixed(3)}s`);
  log(`  サンプル: start=${startIdx}, end=${endIdx}, length=${endIdx - startIdx}`);

  const mono = extractMonoSamples(buffer, startIdx, endIdx);

  let blob;
  if (outFormat === "ogg") {
    log(`  Ogg 品質: q=${oggQuality}`);
    blob = await monoFloatToOggBlob(mono, sr, oggQuality);
  } else if (outFormat === "wav") {
    blob = monoFloatToWavBlob(mono, sr);
  } else if (outFormat === "mp3") {
    log("  MP3 エンコード中 (lamejs, 128kbps)...");
    blob = await monoFloatToMp3Blob(mono, sr);
  } else {
    log(`  [エラー] 未対応のフォーマット: ${outFormat}`);
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ext = outFormat === "wav" ? ".wav" : outFormat === "mp3" ? ".mp3" : ".ogg";
  a.href = url;
  a.download = file.name.replace(/\.[^/.]+$/, "") + "_loop" + ext;
  a.click();
  URL.revokeObjectURL(url);

  log(`  出力完了: ${a.download}`);
}

// ===== メイン（複数ファイル一括処理） =====
document.getElementById("runBtn").addEventListener("click", async () => {
  logEl.textContent = "";
  const fileInput = document.getElementById("fileInput");
  const files = Array.from(fileInput.files || []);

  const startSec = parseFloat(document.getElementById("startSec").value || "0");
  const endSec = parseFloat(document.getElementById("endSec").value || "0");
  const searchRadius = parseInt(
    document.getElementById("searchRadius").value || "4000",
    10
  );
  const outFormat = document.getElementById("outFormat").value;
  let oggQuality = parseInt(
    document.getElementById("oggQuality").value || "3",
    10
  );

  if (!files.length) {
    log("入力ファイルを1つ以上選択してください。");
    return;
  }
  if (!(endSec > startSec)) {
    log("終了秒は開始秒より大きくしてください。");
    return;
  }
  if (Number.isNaN(oggQuality)) oggQuality = 3;
  oggQuality = Math.min(10, Math.max(0, oggQuality));

  log(`ファイル数: ${files.length}`);
  log(`共通設定: 開始=${startSec}s, 終了=${endSec}s, 探索範囲=${searchRadius} samples, 出力=${outFormat}`);

  const params = { startSec, endSec, searchRadius, outFormat, oggQuality };

  for (const file of files) {
    try {
      await processSingleFile(file, params);
    } catch (e) {
      console.error(e);
      log(`  [エラー] ${file.name}: ${e && e.message ? e.message : e}`);
    }
  }

  log("--- 全ファイル処理完了 ---");
});