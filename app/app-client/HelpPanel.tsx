export function HelpPanel({ errorMessage }: { errorMessage: string }) {
  if (!errorMessage) return null;
  return (
    <div className="help-panel">
      <p>{errorMessage}</p>
    </div>
  );
}
