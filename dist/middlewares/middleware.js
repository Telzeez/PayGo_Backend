"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = exports.globalError = exports.notFoundError = void 0;
const notFoundError = (req, res) => {
    res.status(404).json({ error: "Unknown endpoint" });
};
exports.notFoundError = notFoundError;
const globalError = (err, req, res, next) => {
    console.log("unhandled error: ", err);
    res.status(500).json({ error: 'Internal Server Error' });
};
exports.globalError = globalError;
const requestLogger = (req, res, next) => {
    console.clear();
    console.log(JSON.stringify({
        method: req.method,
        path: req.path,
        url: req.url
    }, null, 2));
    next();
};
exports.requestLogger = requestLogger;
//# sourceMappingURL=middleware.js.map