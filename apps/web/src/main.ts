import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import Secrets from "./views/Secrets.vue";
import Profiles from "./views/Profiles.vue";
import Devices from "./views/Devices.vue";
import Settings from "./views/Settings.vue";
import Database from "./views/Database.vue";
import "./style.css";
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/secrets" },
    { path: "/secrets", component: Secrets, meta: { title: "Secrets" } },
    { path: "/profiles", component: Profiles, meta: { title: "Profiles" } },
    { path: "/devices", component: Devices, meta: { title: "Devices" } },
    { path: "/database", component: Database, meta: { title: "Database" } },
    { path: "/settings", component: Settings, meta: { title: "Settings" } },
    { path: "/:pathMatch(.*)*", redirect: "/secrets" },
  ],
});
createApp(App).use(router).mount("#app");
