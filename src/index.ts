import express from 'express';
import jobsController from './controllers/jobsController.js';
import logsController from './controllers/logsController.js';

const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
      res.status(200).json({
          status: 'ok'
      });
});

app.use('/api/jobs', jobsController);
app.use('/api/logs', logsController);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Background Job Server is running on http://localhost:${PORT}`);
});