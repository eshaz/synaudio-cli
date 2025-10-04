import { runCmd } from "./utilities.js";

const copyToSharedMemoryChunked = (
  inputChunks,
  inputLength,
  outputChunkSeconds,
  outputChunkIntervalSeconds,
  syncStartRange,
  syncEndRange,
  sampleRate,
) => {
  const sharedMemories = [];
  const samplesPerChunk = sampleRate * outputChunkSeconds;
  const samplesToSkip = sampleRate * outputChunkIntervalSeconds;

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
        syncStart:
          Math.round(
            sharedMemories.length * outputChunkIntervalSeconds - syncStartRange,
          ) * sampleRate,
        syncEnd:
          Math.round(
            sharedMemories.length * outputChunkIntervalSeconds + syncEndRange,
          ) * sampleRate,
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

export const decodeAndSave = async (
  inputFile,
  sampleRate,
  rectify,
  chunkSize = 0,
  chunkInterval = 0,
  syncStartRange,
  syncEndRange,
) => {
  const { promise, stdout } = runCmd("ffmpeg", [
    "-v",
    "error",
    "-i",
    inputFile,
    "-map",
    "0:a:0", // only support one audio file
    "-ac",
    "1",
    "-ar",
    sampleRate,
    "-f",
    "f32le",
    "-acodec",
    "pcm_f32le",
    "-",
  ]);

  const outputChunks = [];
  let outputSamples = 0;

  stdout.on("data", (data) => {
    const decoded = new Float32Array(data.buffer);

    // rectify to avoid comparison issues with phase
    if (rectify) {
      for (let i = 0; i < decoded.length; i++) {
        decoded[i] = decoded[i] < 0 ? -decoded[i] : decoded[i];
      }
    }
    outputChunks.push(decoded);
    outputSamples += decoded.length;
  });

  await promise;

  return chunkSize === 0
    ? copyToSharedMemory(outputChunks, outputSamples)
    : copyToSharedMemoryChunked(
        outputChunks,
        outputSamples,
        chunkSize,
        chunkInterval,
        syncStartRange,
        syncEndRange,
        sampleRate,
      );
};
