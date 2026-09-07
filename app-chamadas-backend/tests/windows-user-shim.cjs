// tsx asks os.userInfo() only to name its temporary folder on Windows. Some
// restricted CI profiles cannot serve that call, so provide the same stable UID
// branch tsx uses on Unix before its loader starts.
if (typeof process.geteuid !== 'function') process.geteuid = () => 0;
