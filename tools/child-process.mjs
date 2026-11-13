export function observeChildExit(child, describe = () => '') {
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  exited.catch(() => {});
  const wait = (work) =>
    Promise.race([
      work,
      exited.then(({ code, signal }) => {
        throw new Error(`Child exited ${code}/${signal}: ${describe()}`);
      }),
    ]);
  return { exited, wait };
}
