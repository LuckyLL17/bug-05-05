import Fastify from 'fastify'; import { openStore } from './domain/persistence'; import { TwinStore } from './domain/store'; import { registerRoutes } from './routes/app-routes';
export function buildApp(storePath?:string){const app=Fastify({logger:false});const store=storePath?openStore(storePath):new TwinStore();registerRoutes(app,store);return app;}
