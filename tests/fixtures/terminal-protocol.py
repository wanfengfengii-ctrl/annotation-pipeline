"""Protocol integration tests use only a fake Docker executable and local PTYs."""
import hashlib
import json
import os
import pty
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path

BRIDGE = Path(__file__).resolve().parents[2] / 'scripts/terminal-session.py'
VERSION = '2026-09-10.mac-terminal2'
CID = 'a' * 64
FAKE = r'''#!/usr/bin/python3
import json,os,shutil,sys
from pathlib import Path
root=Path(__file__).parent
args=sys.argv[1:]
with (root/'calls.jsonl').open('a') as log:
 log.write(json.dumps({'args':args,'tty':os.ttyname(0) if os.isatty(0) else None})+'\n')
state=root/'docker-state.json'
cid='a'*64
if args[0]=='run':
 Path(args[args.index('--cidfile')+1]).write_text(cid)
 state.write_text(json.dumps({'exists':True,'running':True}))
 print('❯ \n bypass permissions on',flush=True)
 count=0
 while count<2:
  b=os.read(0,1)
  if b==b'\x04':
   count+=1
   if count==1:print('Press Ctrl-D again to exit',flush=True)
 state.write_text(json.dumps({'exists':True,'running':False}))
 sys.exit(0)
v=json.loads(state.read_text())
if args[0]=='inspect':
 if (root/'inspect-error').exists():
  print('Daemon temporarily unavailable');sys.exit(1)
 if not v['exists']:
  print('Error: No such object: '+cid);sys.exit(1)
 print(json.dumps({'id':cid,'running':v['running']}));sys.exit(0)
if args[0]=='cp':
 dest=Path(args[2]);dest.mkdir(parents=True,exist_ok=True)
 if (root/'fail-cp').exists():
  (dest/'partial').write_text('partial')
  print('copy failed sk-'+'x'*24);sys.exit(2)
 shutil.copytree(root/'remote-projects',dest,dirs_exist_ok=True)
 print('copied complete projects');sys.exit(0)
if args[0]=='rm':
 state.write_text(json.dumps({'exists':False,'running':False}))
 if (root/'uncertain-rm').exists():(root/'inspect-error').write_text('1')
 print(cid);sys.exit(0)
sys.exit(4)
'''


class TerminalProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='terminal-protocol-')
        self.root = Path(self.temp.name).resolve()
        self.task = self.root / str(uuid.uuid4())
        self.qid = str(uuid.uuid4())
        self.terminal = self.task / 'questions' / self.qid / 'terminal'
        self.terminal.mkdir(parents=True)
        self.docker = self.root / 'fake-docker'
        self.docker.write_text(FAKE)
        self.docker.chmod(0o700)
        remote = self.root / 'remote-projects'
        (remote / '-workspace' / 'subagents').mkdir(parents=True)
        (remote / '.hidden').write_text('hidden trace metadata')
        (remote / '-workspace' / 'session.jsonl').write_text('{"type":"user"}\n')
        (remote / '-workspace' / 'subagents' / 'side.jsonl').write_text('{"type":"assistant"}\n')
        self.run_id = str(uuid.uuid4())
        self.socket = '/tmp/terminal-test-' + str(uuid.uuid4()) + '.sock'
        self.spec = {
            'transport': 'mac-terminal', 'terminalProtocolVersion': VERSION,
            'runId': self.run_id, 'statePath': str(self.terminal / 'state.json'),
            'logPath': str(self.terminal / 'screen.log'), 'socketPath': self.socket,
            'containerIdPath': str(self.terminal / 'container.id'),
            'operationDir': str(self.terminal / 'operations'),
            'dockerBinary': str(self.docker), 'args': ['run', '-it', '--init', 'fake-image'],
        }
        self.spec_path = self.terminal / 'launch.json'
        self.spec_path.write_text(json.dumps(self.spec))
        self.master, slave = pty.openpty()
        self.process = subprocess.Popen([sys.executable, str(BRIDGE), str(self.spec_path)],
                                        stdin=slave, stdout=slave, stderr=slave,
                                        env=dict(os.environ, apikey='fake-test-authentication'))
        os.close(slave)
        self.output = bytearray()
        def drain():
            try:
                while True:
                    data = os.read(self.master, 65536)
                    if not data: break
                    self.output.extend(data)
            except OSError:
                pass
        self.drain_thread = threading.Thread(target=drain, daemon=True)
        self.drain_thread.start()
        self.wait_state('running')

    def tearDown(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        os.close(self.master)
        self.drain_thread.join(timeout=1)
        self.temp.cleanup()

    def state(self):
        return json.loads(Path(self.spec['statePath']).read_text())

    def wait_state(self, status):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if self.state()['status'] == status: return self.state()
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            if self.process.poll() is not None:
                self.fail('bridge ended prematurely: ' + self.output.decode(errors='replace'))
            time.sleep(0.02)
        self.fail('phase did not reach ' + status + ': ' + self.output.decode(errors='replace'))

    def request(self, payload):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(5)
            connection.connect(self.socket)
            connection.sendall((json.dumps({'runId': self.run_id, **payload}) + '\n').encode())
            data = b''
            while b'\n' not in data:
                data += connection.recv(65536)
            return json.loads(data.split(b'\n')[0])

    def command(self, action, op=None, **values):
        return self.request({'op': 'command', 'action': action,
                             'operationId': op or str(uuid.uuid4()), 'containerId': CID, **values})

    def stop_claude(self):
        import base64
        for _ in range(2):
            self.assertTrue(self.request({'op': 'input', 'data': base64.b64encode(b'\x04').decode()})['ok'])
        return self.wait_state('postprocessing')

    def destination(self):
        return self.task / (self.qid + '.final.traces-' + str(uuid.uuid4())) / 'projects'

    def calls(self, action):
        return [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()
                if json.loads(line)['args'][0] == action]

    def finalize(self, copy):
        dest = Path(copy['receiptPath'])
        request = json.loads(dest.read_text())['request']
        exported = Path(request['destination'])
        manifest = {'containerId': CID, 'files': copy['manifest']}
        manifest_path = exported.parent / 'manifest.json'
        manifest_path.write_text(json.dumps(manifest))
        final = {'runId': self.run_id, 'taskId': self.task.name, 'questionId': self.qid,
                 'containerId': CID, 'status': 'removed', 'commandTransport': 'original-mac-terminal',
                 'manifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                 'traceExport': {'verified': True, 'exportKind': 'final', 'path': str(exported),
                                 'manifestPath': str(manifest_path)}}
        (self.terminal / 'finalization.json').write_text(json.dumps(final))

    def test_original_tty_stays_open_until_whole_export_remove_and_complete(self):
        self.assertFalse(self.command('cp', destination=str(self.destination()))['ok'])
        nested = self.root / 'remote-projects' / '-workspace' / 'session' / 'tool-results'
        nested.mkdir(parents=True)
        (nested / 'large-output.txt').write_text('original tool output')
        stopped = self.stop_claude()
        self.assertIsNone(self.process.poll())
        self.assertFalse(self.request({'op': 'input', 'data': 'BA=='})['ok'])
        copied = self.command('cp', op='copy-one', destination=str(self.destination()))
        self.assertTrue(copied['ok'], copied)
        self.assertEqual(len(copied['manifest']), 4)
        request = json.loads(Path(copied['receiptPath']).read_text())['request']
        self.assertEqual(self.request(request), copied)
        self.assertEqual(len(self.calls('cp')), 1)
        observation = self.command('inspect', op='inspection-before-removal')
        self.assertTrue(observation['exists'])
        self.assertFalse(self.command('complete', op='complete-before-remove')['ok'])
        removed = self.command('rm', op='remove-one')
        self.assertTrue(removed['ok'], removed)
        self.assertEqual(self.command('rm', op='remove-one'), removed)
        self.assertEqual(len(self.calls('rm')), 1)
        self.assertEqual(self.command('inspect', op='inspection-before-removal'), observation)
        self.assertFalse(self.command('inspect')['exists'])
        self.assertIsNone(self.process.poll())
        self.assertFalse(self.command('complete', op='complete-' + CID)['ok'])
        self.finalize(copied)
        result = self.command('complete', op='complete-' + CID)
        self.assertTrue(result['ok'], result)
        self.process.wait(timeout=5)
        self.assertEqual(self.state()['status'], 'exited')
        self.assertTrue(self.state()['postprocessingComplete'])
        for action in ['cp', 'inspect', 'rm']:
            self.assertTrue(all(c['tty'] == stopped['tty'] for c in self.calls(action)))
        self.assertIn(b'$ docker cp ', self.output)
        self.assertIn(b'$ docker rm ', self.output)

    def test_failed_copy_preserves_terminal_and_rejects_injection_foreign_paths_and_ids(self):
        self.stop_claude()
        for values in [
            {'action': 'exec', 'operationId': 'bad'},
            {'action': 'inspect', 'operationId': 'bad', 'containerId': 'b' * 64},
            {'action': 'cp', 'operationId': 'bad', 'destination': '/tmp/stolen'},
            {'action': 'inspect', 'operationId': 'bad', 'argv': ['rm', '-f', 'other']},
            {'action': 'cp', 'operationId': '../escape', 'destination': str(self.destination())},
        ]:
            result = self.request({'op': 'command', 'containerId': CID, **values})
            self.assertFalse(result['ok'], values)
        target = self.destination()
        target.parent.mkdir()
        target.symlink_to(self.root / 'remote-projects', target_is_directory=True)
        self.assertFalse(self.command('cp', destination=str(target))['ok'])
        self.assertFalse(self.command('rm')['ok'])
        (self.root / 'fail-cp').write_text('1')
        bad_dest = self.destination()
        failed = self.command('cp', op='copy-failed', destination=str(bad_dest))
        self.assertFalse(failed['ok'])
        self.assertEqual(failed['status'], 'failed')
        self.assertNotIn('sk-' + 'x' * 24, json.dumps(failed))
        self.assertIsNone(self.process.poll())
        self.assertEqual(self.command('cp', op='copy-failed', destination=str(bad_dest)), failed)
        self.assertEqual(len(self.calls('cp')), 1)
        (self.root / 'fail-cp').unlink()
        self.assertTrue(self.command('cp', destination=str(self.destination()))['ok'])
        self.assertEqual(len(self.calls('cp')), 2)

    def test_uncertain_remove_reconciles_only_original_id_without_replaying_rm(self):
        self.stop_claude()
        self.assertTrue(self.command('cp', destination=str(self.destination()))['ok'])
        (self.root / 'uncertain-rm').write_text('1')
        first = self.command('rm', op='uncertain-remove')
        self.assertEqual(first['status'], 'uncertain')
        self.assertFalse(first['ok'])
        self.assertEqual(len(self.calls('rm')), 1)
        (self.root / 'inspect-error').unlink()
        reconciled = self.command('rm', op='uncertain-remove')
        self.assertTrue(reconciled['ok'], reconciled)
        self.assertTrue(reconciled['reconciled'])
        self.assertEqual(len(self.calls('rm')), 1)
        self.assertTrue(all(c['args'][-1] == CID for c in self.calls('rm')))

    def test_disconnected_client_recovers_copy_receipt_without_repeating_copy(self):
        self.stop_claude()
        payload = {'runId': self.run_id, 'op': 'command', 'action': 'cp',
                   'operationId': 'copy-lost-ack', 'containerId': CID,
                   'destination': str(self.destination())}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(self.socket)
            connection.sendall((json.dumps(payload) + '\n').encode())
        receipt = self.terminal / 'operations' / 'copy-lost-ack.json'
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if receipt.exists() and json.loads(receipt.read_text()).get('result', {}).get('ok'):
                break
            time.sleep(0.02)
        recovered = self.request(payload)
        self.assertTrue(recovered['ok'], recovered)
        self.assertEqual(len(self.calls('cp')), 1)
        self.assertIsNone(self.process.poll())


if __name__ == '__main__':
    unittest.main()
