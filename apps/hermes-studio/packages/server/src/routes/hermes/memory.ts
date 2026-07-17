import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/memory'

export const memoryRoutes = new Router()

memoryRoutes.get('/api/hermes/memory', ctrl.get)
memoryRoutes.get('/api/hermes/memory/history', ctrl.history)
memoryRoutes.post('/api/hermes/memory', ctrl.save)
memoryRoutes.post('/api/hermes/memory/restore', ctrl.restore)
