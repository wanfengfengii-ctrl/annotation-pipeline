"""Runs only inside a visible Mac Terminal. Relays terminal bytes to docker run -it."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import socket
import struct
import subprocess
import sys
import termios
import tty
from pathlib import Path

spec = json.loads(Path(sys.argv[1]).read_text())
state_path = Path(spec['statePath'])
state = {'runId': spec['runId'], 'pid': os.getpid(), 'realTerminal': os.isatty(0), 'status': 'starting'}
def publish(**values):
    state.update(values)
    temp = str(state_path) + '.tmp'
    Path(temp).write_text(json.dumps(state))
    os.chmod(temp, 0o600)
    os.replace(temp, state_path)

if not os.isatty(0) or not os.isatty(1):
    publish(status='error', error='A visible Terminal TTY is required')
    raise SystemExit(1)
state['tty'] = os.ttyname(0)
args = spec['args']
if args[0] != 'run' or '-it' not in args or '-d' in args or '--rm' in args:
    publish(status='error', error='Only a new interactive container is allowed')
    raise SystemExit(1)
settings = json.loads((Path.home()/'.claude/settings.json').read_text())
key = settings.get('env', {}).get('ANTHROPIC_AUTH_TOKEN') or os.environ.get('apikey')
if not key:
    publish(status='error', error='Missing configured authentication')
    raise SystemExit(1)
env = dict(os.environ, apikey=key)
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(spec['socketPath'])
os.chmod(spec['socketPath'], 0o600)
server.listen(4)
master, slave = pty.openpty()
size = fcntl.ioctl(0, termios.TIOCGWINSZ, struct.pack('HHHH', 48, 160, 0, 0))
fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
tty.setraw(slave)
old = termios.tcgetattr(0)
log = open(spec['logPath'], 'ab', buffering=0)
os.chmod(spec['logPath'], 0o600)
child = subprocess.Popen([spec['dockerBinary']] + args, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
os.close(slave)
publish(status='running', childPid=child.pid)
clients = {}
def stop(*_):
    raise KeyboardInterrupt()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
def send_bytes(data):
    while data:
        n = os.write(master, data)
        data = data[n:]
try:
    tty.setraw(0)
    while child.poll() is None:
        ready, _, _ = select.select([master, 0, server]+list(clients), [], [], 0.2)
        for fd in ready:
            if fd == master:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b''
                if data:
                    os.write(1, data)
                    log.write(data)
            elif fd == 0:
                data = os.read(0, 65536)
                if not data:
                    raise KeyboardInterrupt()
                send_bytes(data)
            elif fd is server:
                conn, _ = server.accept()
                clients[conn] = b''
            else:
                data = fd.recv(65536)
                if not data:
                    fd.close(); clients.pop(fd, None); continue
                clients[fd] += data
                if len(clients[fd]) > 1024*1024:
                    fd.close(); clients.pop(fd, None); continue
                if b'\n' not in clients[fd]:
                    continue
                try:
                    request = json.loads(clients[fd].split(b'\n')[0])
                    if request['runId'] != spec['runId'] or request['op'] != 'input':
                        raise ValueError('Invalid terminal request')
                    send_bytes(base64.b64decode(request['data'], validate=True))
                    fd.sendall(b'{"ok":true}\n')
                except Exception:
                    fd.sendall(b'{"ok":false}\n')
                fd.close(); clients.pop(fd, None)
except KeyboardInterrupt:
    pass
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, old)
    os.close(master)
    log.close()
    server.close()
    for conn in clients:
        conn.close()
    try:
        os.unlink(spec['socketPath'])
    except FileNotFoundError:
        pass
    if child.poll() is None:
        child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill(); child.wait()
    publish(status='exited', exitCode=child.returncode)
    print('\nThis question terminal has ended. Its original traces remain in the container until verified export.\n')
