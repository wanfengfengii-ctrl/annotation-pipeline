"""Own one visible Terminal until its exact container is exported and removed."""
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import shlex
import signal
import socket
import struct
import subprocess
import sys
import termios
import tty
from pathlib import Path

PROTOCOL = '2026-09-10.mac-terminal2'
TRACE_ROOT = '/home/node/.claude/projects/.'
INSPECT_FORMAT = '{"id":{{json .Id}},"running":{{json .State.Running}}}'
spec = json.loads(Path(sys.argv[1]).read_text())
state_path = Path(spec['statePath'])
terminal_root = state_path.parent.resolve()
task_root = terminal_root.parent.parent.parent
question_id = terminal_root.parent.name
operations = terminal_root / 'operations'
cid_path = terminal_root / 'container.id'
state = {'runId': spec['runId'], 'pid': os.getpid(), 'realTerminal': os.isatty(0),
         'terminalProtocolVersion': PROTOCOL, 'status': 'starting'}


def atomic_json(file, value):
    temp = str(file) + '.tmp'
    Path(temp).write_text(json.dumps(value, ensure_ascii=False))
    os.chmod(temp, 0o600)
    os.replace(temp, file)


def publish(**values):
    state.update(values)
    atomic_json(state_path, state)


if (not os.isatty(0) or not os.isatty(1) or
        spec.get('terminalProtocolVersion') != PROTOCOL or
        Path(spec.get('containerIdPath', '')).absolute() != cid_path or
        Path(spec.get('operationDir', '')).absolute() != operations):
    publish(status='error', error='A new protocol descriptor and original visible Terminal are required')
    raise SystemExit(1)
state['tty'] = os.ttyname(0)
args = spec['args']
if (not args or args[0] != 'run' or '-it' not in args or
        any(a in ('-d', '--rm', '--cidfile') or a.startswith('--cidfile=') for a in args)):
    publish(status='error', error='Only a new interactive container is allowed')
    raise SystemExit(1)
if cid_path.exists() or operations.exists():
    publish(status='error', error='Existing original Terminal cannot be relaunched')
    raise SystemExit(1)
operations.mkdir(mode=0o700)
args = [args[0], '--cidfile', str(cid_path)] + args[1:]
settings_path = Path.home() / '.claude/settings.json'
settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
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
child = subprocess.Popen([spec['dockerBinary']] + args, stdin=slave, stdout=slave,
                         stderr=slave, env=env, start_new_session=True)
os.close(slave)
publish(status='running', childPid=child.pid)
clients = {}
completed = False


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def stop(*_):
    raise KeyboardInterrupt()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)


def show(text):
    # Docker errors cannot reflect credentials into the Terminal or receipts.
    text = str(text).replace(key, '[redacted]')
    text = re.sub(r'\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})',
                  '[redacted]', text)
    data = text.encode('utf8', errors='replace')
    os.write(1, data)
    log.write(data)
    return text


def send_bytes(data):
    while data:
        n = os.write(master, data)
        data = data[n:]


def drain_native():
    # Preserve the final native output before moving to postprocessing.
    while select.select([master], [], [], 0)[0]:
        try:
            data = os.read(master, 65536)
        except OSError:
            return
        if not data:
            return
        os.write(1, data)
        log.write(data)


def bound_container():
    if cid_path.is_symlink():
        raise ValueError('Container identity receipt cannot be a symbolic link')
    cid = cid_path.read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', cid):
        raise ValueError('Original container ID is unavailable')
    if state.get('containerId') and state['containerId'] != cid:
        raise ValueError('Original container identity changed')
    return cid


def docker_command(argv):
    # Constructed argv only; children inherit the original Terminal, never a shell.
    show('\n$ ' + shlex.join(['docker'] + argv) + '\n')
    try:
        process = subprocess.run([spec['dockerBinary']] + argv, stdin=0,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 env=env, timeout=60)
        output = show(process.stdout.decode('utf8', errors='replace'))
        show('\n[exit ' + str(process.returncode) + ']\n')
        return {'exitCode': process.returncode, 'output': output, 'uncertain': False}
    except subprocess.TimeoutExpired:
        show('[command timed out; original container retained pending inspection]\n')
        return {'exitCode': None, 'output': 'Command timed out', 'uncertain': True}


def inspect(cid):
    result = docker_command(['inspect', '--format', INSPECT_FORMAT, cid])
    if result['exitCode'] == 0:
        data = json.loads(result['output'])
        if data.get('id') != cid or not isinstance(data.get('running'), bool):
            raise ValueError('Original container inspection mismatch')
        result.update(exists=True, running=data['running'])
    elif (not result['uncertain'] and
          re.search(r'No such (?:object|container):?\s*' + re.escape(cid), result['output'], re.I)):
        result.update(exists=False, running=False)
    else:
        result.update(exists=None, running=None)
    return result


def destination_path(value, empty=True):
    if not isinstance(value, str) or any(ord(c) < 32 for c in value):
        raise ValueError('Invalid trace destination')
    dest = Path(value)
    if not dest.is_absolute() or '..' in dest.parts:
        raise ValueError('Trace destination must be absolute')
    relative = dest.relative_to(task_root)
    if (len(relative.parts) != 2 or relative.parts[1] not in ('projects', 'verification') or
            not re.fullmatch(re.escape(question_id) + r'\.final\.traces-[a-f0-9-]{36}', relative.parts[0])):
        raise ValueError('Trace destination must belong to this original question')
    current = task_root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('Trace destination cannot follow a symbolic link')
    if dest.exists() and (not dest.is_dir() or (empty and any(dest.iterdir()))):
        raise ValueError('Trace destination must be empty')
    if empty:
        dest.mkdir(parents=True, exist_ok=True, mode=0o700)
    return dest


def inventory(root):
    if not root.is_dir() or root.is_symlink():
        raise ValueError('Export directory is missing or replaced')
    files = []
    for p in sorted(root.rglob('*')):
        if p.is_symlink():
            raise ValueError('Export contains a symbolic link')
        if p.is_dir():
            continue
        if not p.is_file():
            raise ValueError('Export contains a non-file')
        digest = hashlib.sha256()
        with p.open('rb') as src:
            for block in iter(lambda: src.read(1024 * 1024), b''):
                digest.update(block)
        files.append({'name': str(p.relative_to(root)), 'bytes': p.stat().st_size,
                      'sha256': digest.hexdigest()})
    return files


def verified_export(cid):
    for file in operations.glob('*.json'):
        if file.is_symlink():
            raise ValueError('Operation receipt cannot be a symbolic link')
        record = json.loads(file.read_text())
        result = record.get('result', {})
        if (record.get('request', {}).get('containerId') == cid and
                result.get('action') == 'cp' and result.get('status') == 'succeeded'):
            dest = destination_path(record['request']['destination'], empty=False)
            if not dest.is_symlink() and inventory(dest) == result.get('manifest'):
                return True
    return False


def verified_finalization(cid):
    file = terminal_root / 'finalization.json'
    if file.is_symlink() or not file.is_file():
        return False
    final = json.loads(file.read_text())
    if (final.get('runId') != spec['runId'] or final.get('containerId') != cid or
            final.get('questionId') != question_id or final.get('taskId') != task_root.name or
            final.get('status') != 'removed' or
            final.get('commandTransport') != 'original-mac-terminal'):
        return False
    exported = final.get('traceExport', {})
    dest = destination_path(exported.get('path'), empty=False)
    manifest_path = dest.parent / 'manifest.json'
    if (exported.get('verified') is not True or exported.get('exportKind') != 'final' or
            dest.name != 'projects' or exported.get('manifestPath') != str(manifest_path) or
            manifest_path.is_symlink() or not manifest_path.is_file()):
        return False
    data = manifest_path.read_bytes()
    manifest = json.loads(data)
    copied_here = any(
        record.get('request', {}).get('containerId') == cid and
        record.get('request', {}).get('destination') == str(dest) and
        record.get('result', {}).get('action') == 'cp' and
        record.get('result', {}).get('status') == 'succeeded' and
        record.get('result', {}).get('manifest') == inventory(dest)
        for record in (json.loads(p.read_text()) for p in operations.glob('*.json') if not p.is_symlink()))
    return (copied_here and hashlib.sha256(data).hexdigest() == final.get('manifestSha256') and
            manifest.get('containerId') == cid and
            sorted(manifest.get('files', []), key=lambda f: f['name']) ==
            sorted(inventory(dest), key=lambda f: f['name']))


def handle_command(request):
    global completed
    if state['status'] != 'postprocessing':
        raise ValueError('Final export requires original Terminal postprocessing state')
    action = request.get('action')
    keys = {'runId', 'op', 'operationId', 'action', 'containerId'}
    if action == 'cp':
        keys.add('destination')
    if set(request) != keys or action not in ('inspect', 'cp', 'rm', 'complete'):
        raise ValueError('Only fixed inspect, whole-project cp, rm and complete operations are allowed')
    operation_id = request['operationId']
    if not isinstance(operation_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', operation_id):
        raise ValueError('Invalid operation ID')
    cid = bound_container()
    if request['containerId'] != cid:
        raise ValueError('Operation does not target the original container')
    file = operations / (operation_id + '.json')
    record = None
    if file.exists():
        if file.is_symlink():
            raise ValueError('Operation receipt cannot be a symbolic link')
        record = json.loads(file.read_text())
        if record['request'] != request:
            raise ValueError('An operation ID cannot be reused for a different request')
        prior_status = record.get('result', {}).get('status')
        if prior_status == 'succeeded' or (prior_status == 'failed' and action != 'complete'):
            return record['result']
        # Never replay a possibly completed mutation. Removal is reconciled by
        # fresh inspection of the fixed ID; a reused name is never considered.
        if action not in ('rm', 'complete'):
            return {'ok': False, 'operationId': operation_id, 'action': action,
                    'containerId': cid, 'status': 'uncertain', 'receiptPath': str(file)}
        if record.get('result'):
            record.setdefault('previousResults', []).append(record['result'])
    else:
        if action == 'cp':
            destination_path(request['destination'])
        record = {'version': PROTOCOL, 'request': request, 'status': 'started',
                  'startedAt': timestamp(), 'runId': spec['runId'], 'tty': state['tty']}
        atomic_json(file, record)
    result = {'ok': True, 'operationId': operation_id, 'action': action,
              'containerId': cid, 'receiptPath': str(file), 'status': 'failed',
              'runId': spec['runId'], 'tty': state['tty']}
    try:
        if action == 'inspect':
            result.update(inspect(cid))
            result['status'] = 'succeeded' if result['exists'] is not None else 'failed'
        elif action == 'cp':
            observed = inspect(cid)
            if observed.get('exists') is not True or observed.get('running') is not False:
                raise ValueError('Final export requires the stopped original container')
            dest = destination_path(request['destination'])
            result.update(docker_command(['cp', cid + ':' + TRACE_ROOT, str(dest)]))
            if result['exitCode'] == 0:
                result.update(status='succeeded', manifest=inventory(dest))
            elif result['uncertain']:
                result['status'] = 'uncertain'
        elif action == 'rm':
            if not verified_export(cid):
                raise ValueError('A successful unchanged whole-project export is required before removal')
            observed = inspect(cid)
            if observed.get('exists') is False:
                if record.get('mutationStarted'):
                    result.update(status='succeeded', exitCode=0, removed=True, reconciled=True)
                else:
                    raise ValueError('Container disappeared without this Terminal removal receipt')
            elif observed.get('exists') is not True or observed.get('running') is not False:
                raise ValueError('Removal requires the stopped original container')
            elif record.get('mutationStarted'):
                result.update(status='uncertain', removed=False,
                              output='Original ID still exists; uncertain removal was not replayed')
            else:
                record['mutationStarted'] = True
                atomic_json(file, record)
                result.update(docker_command(['rm', cid]))
                checked = inspect(cid)
                if checked.get('exists') is False:
                    result.update(status='succeeded', removed=True, reconciled=result['exitCode'] != 0)
                else:
                    result.update(status='failed' if result['exitCode'] not in (0, None) and
                                  checked.get('exists') is True else 'uncertain', removed=False)
        else:
            removed = False
            for p in operations.glob('*.json'):
                if p.is_symlink():
                    raise ValueError('Operation receipt cannot be a symbolic link')
                removal = json.loads(p.read_text())
                if (removal.get('request', {}).get('containerId') == cid and
                        removal.get('result', {}).get('action') == 'rm' and
                        removal.get('result', {}).get('status') == 'succeeded' and
                        removal.get('result', {}).get('removed') is True):
                    removed = True
            if (not removed or not verified_export(cid) or not verified_finalization(cid) or
                    inspect(cid).get('exists') is not False):
                raise ValueError('Verified export and original-container removal must finish before closing')
            result.update(status='succeeded', exitCode=0, completed=True)
            publish(postprocessingComplete=True, verifiedExport=True, containerRemoved=True,
                    completeOperationId=operation_id, completedAt=timestamp())
            completed = True
    except Exception as error:
        result.update(status='uncertain' if action == 'rm' and record.get('mutationStarted') else 'failed',
                      error=show('[postprocessing retained] ' + str(error) + '\n').strip())
    result['ok'] = result['status'] == 'succeeded'
    result['finishedAt'] = timestamp()
    record['result'] = result
    record['status'] = result['status']
    atomic_json(file, record)
    return result


try:
    tty.setraw(0)
    while not completed:
        if state['status'] == 'running' and child.poll() is not None:
            drain_native()
            try:
                cid = bound_container()
            except Exception:
                cid = None
            publish(status='postprocessing', exitCode=child.returncode, containerId=cid,
                    postprocessingStartedAt=timestamp())
            show('\nClaude has exited. This original Mac Terminal remains open for verified export and removal.\n')
        watched = [0, server] + list(clients)
        if state['status'] == 'running':
            watched.append(master)
        ready, _, _ = select.select(watched, [], [], 0.2)
        for fd in ready:
            if fd == master:
                drain_native()
            elif fd == 0:
                data = os.read(0, 65536)
                if not data:
                    raise KeyboardInterrupt()
                if state['status'] == 'running':
                    send_bytes(data)
            elif fd is server:
                conn, _ = server.accept()
                clients[conn] = b''
            else:
                try:
                    data = fd.recv(65536)
                except ConnectionResetError:
                    fd.close(); clients.pop(fd, None); continue
                if not data:
                    fd.close(); clients.pop(fd, None); continue
                clients[fd] += data
                if len(clients[fd]) > 1024 * 1024:
                    fd.close(); clients.pop(fd, None); continue
                if b'\n' not in clients[fd]:
                    continue
                try:
                    request = json.loads(clients[fd].split(b'\n')[0])
                    if request.get('runId') != spec['runId']:
                        raise ValueError('Invalid terminal identity')
                    if request.get('op') == 'input':
                        if state['status'] != 'running' or set(request) != {'runId', 'op', 'data'}:
                            raise ValueError('Claude input is closed during postprocessing')
                        send_bytes(base64.b64decode(request['data'], validate=True))
                        response = {'ok': True}
                    elif request.get('op') == 'command':
                        response = handle_command(request)
                    else:
                        raise ValueError('Unsupported terminal operation')
                except Exception as error:
                    response = {'ok': False, 'status': 'rejected', 'error': str(error)}
                try:
                    fd.sendall((json.dumps(response) + '\n').encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Persistent operation receipts resolve lost acknowledgements.
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
    publish(status='exited' if completed else 'interrupted', exitCode=0 if completed else child.returncode)
    if completed:
        print('\nThis question terminal has ended. Verified export and original container removal are complete.\n')
