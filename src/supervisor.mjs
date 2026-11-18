import http from 'node:http';
export class DockerSupervisor {
  constructor(name = 'ai-worker', socketPath = '/var/run/docker.sock') { this.name = name; this.socketPath = socketPath; }
  request(action) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, method: 'POST', path: `/containers/${encodeURIComponent(this.name)}/${action}` }, res => {
        res.resume(); res.on('end', () => [204,304].includes(res.statusCode) || (action === 'kill' && res.statusCode === 409) ? resolve() : reject(new Error(`Docker ${action}: ${res.statusCode}`)));
      }); req.setTimeout(15000, () => req.destroy(new Error('Docker timeout'))); req.on('error', reject); req.end();
    });
  }
  stop() { return this.request('kill'); }
  start() { return this.request('start'); }
}
