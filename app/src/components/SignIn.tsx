// Google sign-in. The first time on a Mac the OAuth client file may need choosing (see google.rs).
import { useEffect, useState } from "react";
import logo from "../assets/logo.png";
import { backend } from "../backend";
import { useStore } from "../store";
import { GoogleDriveMark, GoogleMark, Icon } from "./icons";
import { VersionLine } from "./UpdateBar";

export function SignIn() {
  const setUser = useStore((s) => s.setUser);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    backend.googleConfigured().then(setConfigured, () => setConfigured(false));
  }, []);

  async function signIn() {
    setError(null);
    setWaiting(true);
    try {
      setUser(await backend.signIn());
    } catch (e) {
      setError(String(e));
    } finally {
      setWaiting(false);
    }
  }

  async function chooseClient() {
    setError(null);
    try {
      if (await backend.chooseGoogleClient()) setConfigured(true);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="signin">
      <div className="signin-card">
        <img src={logo} className="logo" alt="PIXELMAPPERS" />
        <h1>Show Sheet</h1>
        <p className="sub">Sign in with your Pixelmappers Google account.</p>
        <button className="gbtn" onClick={signIn} disabled={waiting || configured === false}><GoogleMark /> Continue with Google</button>
        {waiting && <div className="signin-wait"><div className="spinner" />Finish signing in in your browser…</div>}
        {configured === false && (
          <div className="signin-setup">
            <strong>Google sign-in isn't set up on this Mac</strong>
            <span>Choose the OAuth client file (a “Desktop app” client from Google Cloud).</span>
            <div><button className="sm" onClick={chooseClient}>Choose client file…</button></div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="signin-notes">
          <div><GoogleDriveMark className="ico" /><span>Shows save to Google Drive</span></div>
          <div><Icon name="users" /><span>Share shows with your team in Drive</span></div>
          <div><Icon name="sheet" /><span>Opens on any Mac with your Drive</span></div>
        </div>
      </div>
      <div style={{ position: "fixed", bottom: 14 }}><VersionLine /></div>
    </div>
  );
}
