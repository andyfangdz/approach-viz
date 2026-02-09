export function HelpPanel({ errorMessage }: { errorMessage: string }) {
  if (errorMessage) {
    return (
      <div className="help-panel">
        <p>{errorMessage}</p>
      </div>
    );
  }

  return (
    <div className="help-panel">
      <p>
        <kbd>Drag</kbd> Rotate view
      </p>
      <p>
        <kbd>Scroll</kbd> Zoom in/out
      </p>
      <p>
        <kbd>Right-drag</kbd> Pan
      </p>
    </div>
  );
}
