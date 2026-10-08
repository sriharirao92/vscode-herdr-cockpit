# Captures what the Herdr TUI draws for the demo session (hb-demo) on a cols x rows terminal, as raw bytes.
#   python3 docs/screenshots/tuicap.py <out.raw> [cols=104] [rows=34]
import os, pty, sys, time, select, signal, struct, fcntl, termios
out = sys.argv[1]
cols, rows = (int(a) for a in (sys.argv[2:4] + ['104', '34'][len(sys.argv[2:4]):]))
pid, fd = pty.fork()
if pid == 0:
    os.environ.update(TERM='xterm-256color', COLORTERM='truecolor', HERDR_SESSION='hb-demo')
    os.execvp('herdr', ['herdr', '--session', 'hb-demo'])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
data = b''
end = time.time() + 5
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.05)
    if r:
        try: data += os.read(fd, 1 << 16)
        except OSError: break
os.write(fd, b'\x02q')  # ctrl+b q: detach; time.sleep(0.5)
os.kill(pid, signal.SIGTERM)
open(out, 'wb').write(data)
