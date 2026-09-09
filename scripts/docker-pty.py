"""A local PTY for Docker's interactive attach; bytes only, no shell evaluation."""
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import tty
import fcntl
import struct

master, slave = pty.openpty()
tty.setraw(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 160, 0, 0))
child = subprocess.Popen(['docker', 'attach', '--sig-proxy=false', sys.argv[1]],
                         stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
def stop(*_):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
try:
    while child.poll() is None:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.2)
        for fd in ready:
            if fd == master:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b''
                if data:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
            else:
                data = os.read(fd, 65536)
                if not data:
                    raise SystemExit(0)
                os.write(master, data)
finally:
    os.close(master)
    if child.poll() is None:
        child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
    sys.exit(child.returncode or 0)
