import { FLACDecoderWebWorker } from "@wasm-audio-decoders/flac";
import SynAudio from "synaudio";
import fs from "fs";
import { spawn } from "child_process";
import { OggOpusDecoderWebWorker, OggOpusDecoder } from "ogg-opus-decoder";

/*

Decode the entire sync source file -> save to float32, sum all channels together

Decode the chunks of other file, 10 seconds every minute or different?

For each chunk, sync to the source file

calculate shrink / stretch

amplify each channel of input file
sync to beginning
shrink / stretch to end

*/

const saveDecodedData = (outputChunks) => (decoded) => {
  if (decoded.samplesDecoded > 0) {
    for (let i = 1; i < decoded.channelData.length; i++) {
      for (let j = 0; j < decoded.samplesDecoded; j++) {
        // sum to mono
        decoded.channelData[0][j] += decoded.channelData[i][j];
      }
    }
    for (let i = 0; i < decoded.channelData[0].length; i++) {
      // positive phase only
      decoded.channelData[0][i] =
        decoded.channelData[0][i] < 0
          ? -decoded.channelData[0][i]
          : decoded.channelData[0][i];
    }
    outputChunks.push(decoded.channelData[0]);
  }
  return decoded.samplesDecoded;
};

const copyToSharedMemoryChunked = (
  inputChunks,
  inputLength,
  outputChunkSeconds,
  outputChunkIntervalSeconds,
) => {
  const sharedMemories = [];
  const samplesPerChunk = 48000 * outputChunkSeconds;
  const samplesToSkip = 48000 * outputChunkIntervalSeconds;

  let sharedMemory = null;

  let currentPosition = 0; // total bytes read
  let nextStart = 0;
  let nextEnd = 0;
  let sharedMemoryPosition = 0;

  for (const chunk of inputChunks) {
    if (currentPosition >= nextEnd) {
      // start a new output chunk
      nextStart = nextEnd + samplesToSkip;
      nextEnd = Math.min(nextStart + samplesPerChunk, inputLength);

      if (nextStart >= inputLength) {
        // next output chunk would start be beyond the input data
        break;
      }
      const sharedMemoryBuffer = new SharedArrayBuffer(
        (nextEnd - nextStart) * Float32Array.BYTES_PER_ELEMENT,
      );
      sharedMemory = new Float32Array(sharedMemoryBuffer);
      sharedMemories.push({
        start: nextStart,
        end: nextEnd,
        data: sharedMemory,
      });
      sharedMemoryPosition = 0;
    }

    const chunkStart = nextStart - currentPosition;
    const chunkEnd = nextEnd - currentPosition;

    if (chunkStart < chunk.length) {
      const chunkLength = chunk.length;
      const startOffset = Math.max(0, chunkStart);
      const endOffset = Math.min(chunkLength, chunkEnd);
      const chunkToCopy = chunk.subarray(startOffset, endOffset);
      sharedMemory.set(chunkToCopy, sharedMemoryPosition);
      sharedMemoryPosition += chunkToCopy.length;
    }

    currentPosition += chunk.length;
  }

  return sharedMemories;
};

const copyToSharedMemory = (inputChunks, inputLength) => {
  let currentPosition = 0;
  const sharedMemoryBuffer = new SharedArrayBuffer(
    inputLength * Float32Array.BYTES_PER_ELEMENT,
  );
  const sharedMemory = new Float32Array(sharedMemoryBuffer);

  for (const chunk of inputChunks) {
    sharedMemory.set(chunk, currentPosition);
    currentPosition += chunk.length;
  }

  return sharedMemory;
};

const decodeAndSave = (inputFile, chunkSize = 0, chunkInterval = 0) => {
  return new Promise(async (resolve, reject) => {
    const outputChunks = [];
    let outputSamples = 0;
    let decoder;

    if (inputFile.endsWith(".ogg")) {
      decoder = new OggOpusDecoderWebWorker();
    } else {
      decoder = new FLACDecoderWebWorker();
    }

    await decoder.ready;
    const readStream = fs.createReadStream(inputFile);

    readStream.on("data", (chunk) => {
      decoder
        .decode(chunk)
        .then((decoded) => {
          return decoded;
        })
        .then(saveDecodedData(outputChunks))
        .then((samplesDecoded) => (outputSamples += samplesDecoded));
    });

    readStream.on("end", async () => {
      decoder
        .flush()
        .then(saveDecodedData(outputChunks))
        .then((samplesDecoded) => (outputSamples += samplesDecoded))
        .then(() => {
          decoder.free();

          resolve(
            chunkSize === 0
              ? copyToSharedMemory(outputChunks, outputSamples)
              : copyToSharedMemoryChunked(
                  outputChunks,
                  outputSamples,
                  chunkSize,
                  chunkInterval,
                ),
          );
        });
    });

    readStream.on("error", (err) => {
      reject(err);
    });
  });
};

function removeOutliers(data) {
  const differences = data.map((d) => d.difference).sort((a, b) => a - b);
  const q1 = differences[Math.floor(differences.length * 0.25)];
  const q3 = differences[Math.floor(differences.length * 0.75)];
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;

  return data.filter((d) => d.difference >= lower && d.difference <= upper);
}

function weightedLinearRegression(data) {
  const cleaned = removeOutliers(data);
  let sumW = 0,
    sumWX = 0,
    sumWY = 0,
    sumWXY = 0,
    sumWXX = 0;

  for (const d of cleaned) {
    const w = d.correlation;
    const x = d.order;
    const y = d.difference;

    sumW += w;
    sumWX += w * x;
    sumWY += w * y;
    sumWXY += w * x * y;
    sumWXX += w * x * x;
  }

  const denominator = sumW * sumWXX - sumWX * sumWX;

  const slope = (sumW * sumWXY - sumWX * sumWY) / denominator;
  const intercept = (sumWY * sumWXX - sumWX * sumWXY) / denominator;

  return { slope, intercept };
}

function simpleLinearRegression(data) {
  const cleaned = removeOutliers(data);
  const n = cleaned.length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;

  for (const point of cleaned) {
    const x = point.order;
    const y = point.difference;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

const runSox = (soxArgs) => {
  return new Promise((resolve, reject) => {
    const sox = spawn("sox", soxArgs);

    sox.stdout.on("data", (data) => {
      console.log(`stdout: ${data}`);
    });

    sox.stderr.on("data", (data) => {
      console.error(`stderr: ${data}`);
    });

    sox.on("close", (code) => {
      if (code !== 0) {
        console.error(`SoX exited with code ${code}`);
      }
      resolve();
    });
  });
};

const trimAndResample = async (
  inputFile,
  outputFile,
  startSeconds,
  endSeconds,
  rate,
) => {
  const tempTrimmed = outputFile + "trimmed.tmp.flac";
  const tempTrimmedLeft = outputFile + "trimmed.tmp.l.flac";
  const tempTrimmedRight = outputFile + "trimmed.tmp.r.flac";
  const tempTrimmedLeftNorm = outputFile + "trimmed.tmp.l.norm.flac";
  const tempTrimmedRightNorm = outputFile + "trimmed.tmp.r.norm.flac";
  try {
    // resample
    console.log("Adjusting speed...");
    await runSox([
      inputFile,
      tempTrimmed,
      "rate",
      "-v",
      "trim",
      startSeconds,
      "speed",
      rate,
    ]);

    // amplify each channel
    console.log("Normalizing...");
    await Promise.all([
      runSox([tempTrimmed, "-c", "1", tempTrimmedLeft, "trim", "0", endSeconds, "remix", "1"]).then(() =>
        runSox([tempTrimmedLeft, tempTrimmedLeftNorm, "--norm"]),
      ),
      runSox([tempTrimmed, "-c", "1", tempTrimmedRight, "trim", "0", endSeconds, "remix", "2"]).then(
        () => runSox([tempTrimmedRight, tempTrimmedRightNorm, "--norm"]),
      ),
    ]);

    console.log("Writing output file...");
    await runSox([
      "--combine",
      "merge",
      tempTrimmedLeftNorm,
      tempTrimmedRightNorm,
      outputFile,
    ]);
  } finally {
    fs.promises.rm(tempTrimmed).catch();
    fs.promises.rm(tempTrimmedLeft).catch();
    fs.promises.rm(tempTrimmedRight).catch();
    fs.promises.rm(tempTrimmedLeftNorm).catch();
    fs.promises.rm(tempTrimmedRightNorm).catch();
  }
};

const main = async () => {
  const baseFile = process.argv[2];
  const comparisonFile = process.argv[3];
  const sampleRate = 48000;
  const chunkSize = 0.125;
  const chunkInterval = 60;

  let synaudio = new SynAudio({
    correlationSampleSize: chunkSize * sampleRate,
    initialGranularity: 16,
    shared: true
  });

  console.log("Decoding files...");
  let [baseFileDecoded, comparisonFileChunks] = await Promise.all([
    decodeAndSave(baseFile),
    decodeAndSave(comparisonFile, chunkSize, chunkInterval),
  ]);
  const baseFileDecodedLength = baseFileDecoded.length

  process.stdout.write("Synchronizing files...");
  const syncResults = synaudio.syncOneToMany(
      {
        channelData: [baseFileDecoded],
        samplesDecoded: baseFileDecoded.length,
      },
      comparisonFileChunks.map((comparisonChunk) => ({
        channelData: [comparisonChunk.data],
        samplesDecoded: comparisonChunk.data.length,
      })),
      16,
      (progress) =>
        process.stdout.write(`\rSynchronizing files... ${Math.round(progress * 100)}%`),
    )
  // dereference these so they can be garbage collected as soon as possible
  baseFileDecoded = null;
  comparisonFileChunks.forEach(chunk => chunk.data = null)

  const results = (await syncResults).map((sr, i) => ({
    ...sr,
    order: i,
    difference: (comparisonFileChunks[i].start - sr.sampleOffset) / sampleRate,
    start: comparisonFileChunks[i].start,
    end: comparisonFileChunks[i].end,
  }));
  process.stdout.write("\n");

  synaudio = null; 

  //*/
  const { slope, intercept } = simpleLinearRegression(results);
  const startSeconds = intercept;
  const endSeconds = baseFileDecodedLength / 48000;
  const rate = 1 + slope / chunkInterval;

  console.log("Trim Start", startSeconds, "Trim End", endSeconds, "Rate", rate);
  await trimAndResample(
    comparisonFile,
    comparisonFile + ".level.flac",
    startSeconds,
    endSeconds,
    rate,
  );

  console.log("Done");
  setTimeout(() => process.exit(0), 3000);
};

main();
