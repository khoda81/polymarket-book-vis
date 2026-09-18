import "@/styles/global.css";
import "@/styles/component.css";
import App from "./app/App.svelte";
import { mount } from "svelte";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app mount target");

mount(App, { target });
