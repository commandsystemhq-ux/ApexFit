export async function generateTrainingPlan(input) {
  void input;
  const error = new Error('AI generation is not connected yet. Configure a secure backend endpoint to enable it.');
  error.code = 'AI_NOT_CONFIGURED';
  throw error;
}
