import chalk from "chalk";

type Task = () => Promise<void>;

class BuildQueue {
  private running = false;
  private pending: Array<{ repoName: string; task: Task }> = [];

  async enqueue(repoName: string, task: Task): Promise<void> {
    if (this.running) {
      // Drop pending task for same repo (latest wins)
      this.pending = this.pending.filter((t) => t.repoName !== repoName);
      this.pending.push({ repoName, task });
      console.log(chalk.yellow(`[${repoName}] Build already running, queued.`));
      return;
    }

    this.running = true;

    try {
      await task();
    } catch (err: any) {
      console.error(chalk.red(`[${repoName}] Build error: ${err.message}`));
    } finally {
      this.running = false;

      const next = this.pending.shift();
      if (next) {
        this.enqueue(next.repoName, next.task);
      }
    }
  }
}

export const buildQueue = new BuildQueue();
