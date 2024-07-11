import WebSocket, { WebSocketServer } from "ws";
import express from "express";
import { spawn } from "child_process";

function getFileExt(path) {
    return path.split(".")[path.split(".").length - 1].split("?")[0];
}

function uuidv4() {
    let s = (n = 1) =>
        n == 1
            ? Math.floor(Math.random() * 65535)
                  .toString(16)
                  .padStart(4, "0")
            : Math.floor(Math.random() * 65535)
                  .toString(16)
                  .padStart(4, "0") + s(n - 1);
    return [s(2), s(), s(), s(), s(3)].join("-");
}

function getOutputFormat(ext) {
    if (ext == "png") {
        return "-f image2 -c png";
    }
    if (ext == "jpeg" || ext == "jpg") {
        return "-f image2 -c mjpeg";
    }
    if (ext == "mp4") {
        return "-pix_fmt yuv420p -f mp4 -movflags faststart+frag_keyframe+empty_moov";
    }
    return "-f " + ext;
}

const videoFormats = ["mp4", "mkv"];
export function usePreset(filename) {
    if (videoFormats.includes(getFileExt(filename))) {
        return `-preset ultrafast`;
    }
    return "";
}

function ffmpegBuffer(
    socket,
    args,
    buffers,
    outExt = "",
    enableUpdateStreaming = false,
    expectedResultLengthFrames = 1
) {
    return new Promise((resolve, reject) => {
        const ffmpegVerbose = false;
        if (!outExt) outExt = getFileExt(buffers[0][1]);
        outExt = outExt.toLowerCase();
        let verbosityArg =
            enableUpdateStreaming || ffmpegVerbose ? "-v info" : "-v warning";
        let newargs = (
            verbosityArg +
            " -hide_banner " +
            args
                .replace(/\r?\n/g, "")
                .replace(/\$PRESET/g, `${usePreset(outExt)}`)
                .replace(/\$OUT/g, `${getOutputFormat(outExt)} -`)
        ).trim();

        let bufferNames = [];
        for (const [buffer, filename] of buffers) {
            bufferNames.push(
                addBuffer(buffer, getFileExt(filename.toLowerCase()))
            );
        }

        newargs = newargs.replace(/\$BUF([0-9])+/g, (a, b) => {
            return "http://localhost:56033/" + bufferNames[parseInt(b)];
        });

        const childProcess = spawn("ffmpeg", newargs.split(" "), {
            shell: true,
        });
        let chunkedOutput = [];
        let errorLog = "ARGS: ffmpeg " + newargs + "\n";
        childProcess.stdout.on("data", (chunk) => {
            chunkedOutput.push(chunk);
        });
        childProcess.stderr.on("data", (chunk) => {
            errorLog += chunk;
            process.stdout.write(chunk);
            if (
                enableUpdateStreaming &&
                chunk.toString().startsWith("frame=")
            ) {
                let pChunk = chunk.toString();
                let frame = parseInt(pChunk.split("=")[1]);
                let fps = parseFloat(pChunk.split("=")[2]);
                let time = pChunk.split("=")[5].split(" ")[0];
                let speed = parseFloat(pChunk.split("=")[7]);
                let percent = (frame / expectedResultLengthFrames) * 100;
                let update = {
                    fps,
                    frame,
                    time,
                    speed,
                    percent,
                };
                socket.send(JSON.stringify({ type: "update", update: update }));
            }
        });
        childProcess.on("exit", (code) => {
            let file = Buffer.concat(chunkedOutput);
            for (const bufferName of bufferNames) {
                removeBuffer(bufferName);
            }
            if (code == 0) {
                resolve(file);
            } else {
                reject(errorLog);
            }
        });
    });
}

function filestreamServer() {
    return new Promise((resolve) => {
        const app = express();
        let files = {};
        app.get("/", (req, res) => {
            res.status(400).contentType("txt").send("400 Bad Request");
        });
        app.get("/health", (req, res) => {
            res.contentType("txt").send("OK");
        });
        app.get("/filelist", (req, res) => {
            res.contentType("txt").send(Object.keys(files).join("\n"));
        });
        app.get("/:fileID", (req, res) => {
            let fileID = req.params.fileID;
            let file = files[fileID];
            if (!file) {
                res.status(404).contentType("txt").send("404 Not Found");
                return;
            }
            res.setHeader("Accept-Ranges", "bytes");
            let trimmedBuffer = file;
            let status = 200;
            if (req.headers.range) {
                let byteRange = req.headers.range.split("=")[1].split("-");
                trimmedBuffer = file.subarray(
                    parseInt(byteRange[0]),
                    byteRange[1] ? parseInt(byteRange[1]) : file.byteLength
                );
                status = 206;
                res.setHeader(
                    "Content-Range",
                    "bytes " +
                        byteRange[0] +
                        "-" +
                        (byteRange[1] ?? file.byteLength) +
                        "/" +
                        file.byteLength
                );
            }
            res.status(status)
                .contentType(getFileExt(fileID))
                .send(trimmedBuffer);
        });
        function addBufferSequence(buffers, ext) {
            let id = uuidv4();
            let fileID = id + "_%." + ext;
            let i = 0;
            for (const buffer of buffers) {
                files[fileID.replace("%", i.toString().padStart(3, "0"))] =
                    buffer;
                i++;
            }
            return fileID.replace("%", "%03d");
        }
        function addBuffer(buffer, ext) {
            let fileID = uuidv4() + "." + ext;
            files[fileID] = buffer;
            return fileID;
        }
        function removeBuffer(fileID) {
            const ffmpegVerbose = process.env.FFMPEG_VERBOSE == "yes";
            if (ffmpegVerbose) return;
            if (fileID.includes("%03d")) {
                let i = 0;
                while (true) {
                    if (
                        files[
                            fileID.replace(
                                "%03d",
                                i.toString().padStart(3, "0")
                            )
                        ]
                    ) {
                        delete files[
                            fileID.replace(
                                "%03d",
                                i.toString().padStart(3, "0")
                            )
                        ];
                    } else {
                        break;
                    }
                    i++;
                }
            } else {
                delete files[fileID];
            }
        }
        app.listen(56033, () => {
            resolve([addBuffer, removeBuffer, addBufferSequence]);
        });
    });
}

function wsServer() {
    const wss = new WebSocketServer({ port: 56034 });
    wss.on("connection", (ws) => {
        ws.on("error", console.error);

        ws.on("message", (data_str) => {
            let message = JSON.parse(data_str.toString());
            switch (message.type) {
                case "run":
                    let newbuffers = message.buffers.map((b) => [
                        Buffer.from(b[0].data),
                        b[1],
                    ]);
                    ffmpegBuffer(
                        ws,
                        message.args,
                        newbuffers,
                        message.outExt,
                        message.enableUpdateStreaming,
                        message.expectedResultLengthFrames
                    )
                        .then((r) => {
                            ws.send(
                                JSON.stringify({ type: "done", buffer: r }),
                                () => {
                                    ws.close(1000);
                                }
                            );
                        })
                        .catch((e) => {
                            ws.send(
                                JSON.stringify({ type: "error", detail: e }),
                                () => {
                                    ws.close(1000);
                                }
                            );
                        });
                    break;
            }
        });

        ws.send(JSON.stringify({ type: "ready" }));
    });
}

let [addBuffer, removeBuffer, addBufferSequence] = [
    (buffer, ext) => {
        return "null";
    },
    (string) => {
        return;
    },
    (buffer, ext) => {
        return "null";
    },
];

filestreamServer().then((d) => {
    [addBuffer, removeBuffer, addBufferSequence] = d;
    wsServer();
});
