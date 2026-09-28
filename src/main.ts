import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/styles/main.css'
import './assets/styles/preview.css'

createApp(App).use(createPinia()).mount('#app')
