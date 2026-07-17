import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/sensenova'

export const sensenovaRoutes = new Router()

sensenovaRoutes.get('/api/hermes/config/sensenova', ctrl.getConfig)
sensenovaRoutes.put('/api/hermes/config/sensenova', ctrl.saveConfig)
sensenovaRoutes.post('/api/hermes/config/sensenova/test', ctrl.testConfig)
