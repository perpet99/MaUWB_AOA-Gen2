import { useState } from 'react';

export function CameraPanel() {
  const [active, setActive] = useState(false);
  const [error, setError] = useState(false);

  function toggleCamera() {
    if (active) {
      setActive(false);
      return;
    }
    setError(false);
    setActive(true);
  }

  return (
    <section className="panel camera-panel">
      <header className="panel-head">
        <span className="panel-title">camera</span>
        <button className={active ? 'danger' : 'primary'} onClick={toggleCamera}>
          {active ? 'Stop' : 'Start'}
        </button>
      </header>
      <div className="panel-body camera-body">
        {active ? (
          <img
            className="camera-video"
            src="/camera.mjpeg"
            alt="Live view from the server camera"
            onError={() => setError(true)}
          />
        ) : null}
        {!active && !error ? <p className="camera-placeholder">Camera is off</p> : null}
        {error ? <p className="camera-error">Unable to open the server camera.</p> : null}
      </div>
    </section>
  );
}
