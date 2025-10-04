import { spawn } from "child_process";
import os from "os";
import crypto from "crypto";
import path from "path";

export const runCmd = (cmd, args) => {
  const spawned = spawn(cmd, args);
  const promise = new Promise((resolve, reject) => {
    spawned.stderr.on("data", (data) => {
      process.stderr.write(data);
    });

    spawned.on("close", (code) => {
      if (code !== 0) {
        console.error(`${cmd} ${args.join(" ")} exit code ${code}`);
      }
      resolve(code);
    });
  });

  return { promise, stdin: spawned.stdin, stdout: spawned.stdout };
};

export const getFileInfo = async (files) =>
  Promise.all(
    files.map(
      (file) =>
        new Promise((resolve, reject) => {
          const buffers = [];
          const { promise, stdout } = runCmd("ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=channels,bits_per_raw_sample,sample_rate",
            "-of",
            "json",
            file,
          ]);

          stdout.on("data", (data) => {
            buffers.push(data);
          });

          promise.then(() => {
            const fileInfo = JSON.parse(
              Buffer.concat(buffers).toString("utf8"),
            );
            const firstStream = fileInfo?.streams?.[0]; // only supports using the first stream
            if (!firstStream) {
              reject(file + " does not have any audio streams");
            } else {
              resolve({
                sampleRate: firstStream["sample_rate"],
                channels: firstStream["channels"],
                bitDepth: parseInt(firstStream["bits_per_raw_sample"]),
              });
            }
          });
        }),
    ),
  );

export const getTempFile = () => path.join(os.tmpdir(), crypto.randomUUID());
