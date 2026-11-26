"""Trusted host helper. Never run in the model process; no shell or overwrite fallback."""
import ctypes
import hashlib
import json
import os
import stat
import sys


def primitive():
    """Return the native no-overwrite syscall; never fall back to replacement rename."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        fn, flag = getattr(libc, 'renameatx_np', None), 4  # RENAME_EXCL
    elif sys.platform == 'linux':
        fn, flag = getattr(libc, 'renameat2', None), 1  # RENAME_NOREPLACE
    else:
        raise ValueError('Unsupported platform for no-overwrite moves')
    if fn is None:
        raise ValueError('Native no-overwrite rename unavailable')
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    return fn, flag


def parts(value):
    """Validate relative components without permitting metadata or parent traversal."""
    if not isinstance(value, str) or not value or value.startswith('/') or '\\' in value or '\x00' in value:
        raise ValueError('Paths must be relative to the configured work root')
    result = value.split('/')
    if any(p in ('', '.', '..', '.git', '.codex', '.openagents') for p in result):
        raise ValueError('Parent paths and runtime metadata paths are forbidden')
    return result


def directory(parent, components):
    """Return a caller-owned descriptor reached without following symlinks.

    Close only our duplicate on failure; the borrowed parent remains open.
    """
    fd = os.dup(parent)
    try:
        for component in components:
            new_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def identity(st):
    """Capture inode identity and change metadata for approval fingerprints."""
    return [st.st_dev, st.st_ino, st.st_mode, st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def fingerprint(parent, name, digest):
    """Hash names, inode metadata and file bytes through borrowed parent descriptors.

    Each opened child is closed here; concurrent mutations invalidate inspection.
    """
    if name in ('.codex', '.openagents'):
        raise ValueError('Directories containing runtime configuration cannot move')
    st = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISREG(st.st_mode) and not stat.S_ISDIR(st.st_mode):
        raise ValueError('Only regular files and directories without symlinks may move')
    digest.update(json.dumps([name, identity(st)], separators=(',', ':')).encode())
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if stat.S_ISDIR(st.st_mode) else 0), dir_fd=parent)
    try:
        if identity(os.fstat(fd)) != identity(st):
            raise ValueError('Filesystem state changed during inspection')
        if stat.S_ISDIR(st.st_mode):
            for child in sorted(os.listdir(fd)):
                fingerprint(fd, child, digest)
        else:
            while True:
                chunk = os.read(fd, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        if identity(os.fstat(fd)) != identity(st):
            raise ValueError('Filesystem state changed during inspection')
    finally:
        os.close(fd)


execution_started = False

def run(data):
    """Inspect or execute one exact move, owning all opened directory descriptors.

    The fingerprint binds both parents and the recursive source; execution rechecks it before the native no-overwrite rename.
    """
    global execution_started
    fn, flag = primitive()
    root = data['root']
    if not os.path.isabs(root):
        raise ValueError('Work root must be absolute')
    source, destination = parts(data['source']), parts(data['destination'])
    if destination[:len(source)] == source:
        raise ValueError('Cannot move a directory into itself')
    # Walk the absolute root with nofollow too (including every ancestor).
    slash = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        rootfd = directory(slash, [p for p in root.split('/') if p])
    finally:
        os.close(slash)
    srcfd = dstfd = None
    try:
        srcfd, dstfd = directory(rootfd, source[:-1]), directory(rootfd, destination[:-1])
        try:
            os.stat(destination[-1], dir_fd=dstfd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ValueError('Destination already exists')
        digest = hashlib.sha256()
        digest.update(json.dumps([root, source, destination, identity(os.fstat(rootfd)), identity(os.fstat(srcfd)), identity(os.fstat(dstfd))], separators=(',', ':')).encode())
        fingerprint(srcfd, source[-1], digest)
        expected = digest.hexdigest()
        if data.get('execute'):
            if data.get('expected_state') != expected:
                return {'status': 'invalidated', 'result': {'reason': 'Filesystem state changed; fresh approval required'}}
            execution_started = True
            if fn(srcfd, os.fsencode(source[-1]), dstfd, os.fsencode(destination[-1]), flag) != 0:
                errno = ctypes.get_errno()
                raise OSError(errno, os.strerror(errno))
            # Success is the native syscall outcome, never a model assertion.
            try:
                os.fsync(srcfd)
                os.fsync(dstfd)
            except OSError:
                pass  # Rename succeeded; never claim a completed effect did not happen.
            return {'status': 'succeeded', 'result': {'source': data['source'], 'destination': data['destination']}}
        return {'expected_state': expected}
    finally:
        for fd in (srcfd, dstfd, rootfd):
            if fd is not None:
                os.close(fd)


try:
    data = json.load(sys.stdin)
    print(json.dumps(run(data)))
except Exception as error:
    if 'data' in globals() and data.get('execute') and not execution_started:
        print(json.dumps({'status': 'invalidated', 'result': {'reason': str(error)}}))
    else:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
