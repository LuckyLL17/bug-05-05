import { buildApp } from './app';

const stateFile = process.env.STATE_FILE || './data/twin-state.json';
const port = Number(process.env.PORT || 3100);
const app = buildApp({ stateFile });

app.listen({ port, host: '127.0.0.1' })
  .then(() => console.log(`industrial twin listening on ${port} (state: ${stateFile})`))
  .catch(err => { console.error(err); process.exit(1); });
