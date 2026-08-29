const binaries = require("./binaries.cjs");
const converter = require("./converter.cjs");

exports.MAX_DURATION_SECONDS = converter.MAX_DURATION_SECONDS;
exports.MAX_FRAMES = converter.MAX_FRAMES;
exports.MAX_DIMENSION = converter.MAX_DIMENSION;
exports.LoopdropError = converter.LoopdropError;
exports.buildFfmpegArgs = converter.buildFfmpegArgs;
exports.convertToGif = converter.convertToGif;
exports.filterGraph = converter.filterGraph;
exports.normalizeRequest = converter.normalizeRequest;
exports.parseTime = converter.parseTime;
exports.probeVideo = converter.probeVideo;
exports.safeStem = converter.safeStem;
exports.executableName = binaries.executableName;
exports.resolveBinary = binaries.resolveBinary;
