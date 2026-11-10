import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Editor } from "./editor";
import "./styles.css";

const host = document.getElementById("root");
if (host) createRoot(host).render(<App editor={new Editor()} />);
