import { useEffect, useMemo, useRef, useState } from 'react'

type Macro = { calories: number; protein: number; carbs: number; fat: number }
type Food = { id: string; name: string; serving: string; macro: Macro }
type Supplement = { id: string; name: string; dose: string; timing: string }
type MealItem = { foodId: string; servings: number }
type Meal = { name: string; items: MealItem[] }
type CheckIn = { id: string; date: string; weight: number; waist: number; compliance: number; notes: string }
type Client = {
  id: string
  name: string
  goal: string
  dailyTarget: Macro
  meals: Meal[]
  supplements: string[]
  notes: string
  checkIns: CheckIn[]
}

type Template = { name: string; goal: string; target: Macro; meals: string[] }

const STORAGE_KEY = 'meal_planner_saas_v2'

const TEMPLATES: Template[] = [
  {
    name: 'Fat Loss',
    goal: 'Fat loss with high satiety',
    target: { calories: 1900, protein: 180, carbs: 150, fat: 60 },
    meals: ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
  },
  {
    name: 'Muscle Gain',
    goal: 'Lean mass gain',
    target: { calories: 2700, protein: 210, carbs: 300, fat: 75 },
    meals: ['Breakfast', 'Pre-Workout', 'Post-Workout', 'Dinner'],
  },
  {
    name: 'Maintenance',
    goal: 'Performance + recovery',
    target: { calories: 2300, protein: 180, carbs: 220, fat: 70 },
    meals: ['Breakfast', 'Lunch', 'Dinner'],
  },
]

const FOOD_SEED: Food[] = [
  { id: crypto.randomUUID(), name: 'Chicken Breast', serving: '100g', macro: { calories: 165, protein: 31, carbs: 0, fat: 3.6 } },
  { id: crypto.randomUUID(), name: 'White Rice', serving: '100g cooked', macro: { calories: 130, protein: 2.4, carbs: 28, fat: 0.3 } },
  { id: crypto.randomUUID(), name: 'Salmon', serving: '100g', macro: { calories: 208, protein: 20, carbs: 0, fat: 13 } },
  { id: crypto.randomUUID(), name: 'Greek Yogurt', serving: '170g cup', macro: { calories: 100, protein: 17, carbs: 6, fat: 0 } },
]

const SUPPLEMENT_SEED: Supplement[] = [
  { id: crypto.randomUUID(), name: 'Whey Protein', dose: '1 scoop', timing: 'Post-workout' },
  { id: crypto.randomUUID(), name: 'Creatine', dose: '5g', timing: 'Daily' },
]

const CLIENT_SEED: Client[] = [
  {
    id: crypto.randomUUID(),
    name: 'Sample Client',
    goal: 'Lean muscle gain',
    dailyTarget: { calories: 2400, protein: 190, carbs: 240, fat: 70 },
    meals: ['Breakfast', 'Lunch', 'Dinner', 'Snack'].map((name) => ({ name, items: [] })),
    supplements: [],
    notes: 'Weekly review every Sunday.',
    checkIns: [],
  },
]

const clamp = (n: number, min = 0) => (Number.isNaN(n) ? 0 : Math.max(min, n))
const fmt = (n: number) => Math.round(n * 10) / 10

const calcMealMacros = (meal: Meal, foods: Food[]): Macro => {
  const map = new Map(foods.map((f) => [f.id, f]))
  return meal.items.reduce(
    (acc, item) => {
      const food = map.get(item.foodId)
      if (!food) return acc
      acc.calories += food.macro.calories * item.servings
      acc.protein += food.macro.protein * item.servings
      acc.carbs += food.macro.carbs * item.servings
      acc.fat += food.macro.fat * item.servings
      return acc
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  )
}

function App() {
  const fileRef = useRef<HTMLInputElement>(null)

  const [foods, setFoods] = useState<Food[]>([])
  const [supplements, setSupplements] = useState<Supplement[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [selectedClientId, setSelectedClientId] = useState('')

  const [newClientName, setNewClientName] = useState('')
  const [templateName, setTemplateName] = useState(TEMPLATES[0].name)
  const [newFood, setNewFood] = useState({ name: '', serving: '', calories: '', protein: '', carbs: '', fat: '' })
  const [newSupplement, setNewSupplement] = useState({ name: '', dose: '', timing: '' })
  const [checkInForm, setCheckInForm] = useState({ date: new Date().toISOString().slice(0, 10), weight: '', waist: '', compliance: '85', notes: '' })

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      setFoods(FOOD_SEED)
      setSupplements(SUPPLEMENT_SEED)
      setClients(CLIENT_SEED)
      setSelectedClientId(CLIENT_SEED[0].id)
      return
    }
    const parsed = JSON.parse(raw)
    setFoods(parsed.foods?.length ? parsed.foods : FOOD_SEED)
    setSupplements(parsed.supplements?.length ? parsed.supplements : SUPPLEMENT_SEED)
    setClients(parsed.clients?.length ? parsed.clients : CLIENT_SEED)
    setSelectedClientId(parsed.selectedClientId || parsed.clients?.[0]?.id || CLIENT_SEED[0].id)
  }, [])

  useEffect(() => {
    if (!foods.length || !clients.length) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ foods, supplements, clients, selectedClientId }))
  }, [foods, supplements, clients, selectedClientId])

  const selectedClient = useMemo(() => clients.find((c) => c.id === selectedClientId) ?? clients[0], [clients, selectedClientId])

  const dayMacro = useMemo(() => {
    if (!selectedClient) return { calories: 0, protein: 0, carbs: 0, fat: 0 }
    return selectedClient.meals.reduce(
      (acc, meal) => {
        const m = calcMealMacros(meal, foods)
        return {
          calories: acc.calories + m.calories,
          protein: acc.protein + m.protein,
          carbs: acc.carbs + m.carbs,
          fat: acc.fat + m.fat,
        }
      },
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    )
  }, [selectedClient, foods])

  const updateClient = (fn: (c: Client) => Client) => {
    if (!selectedClient) return
    setClients((prev) => prev.map((c) => (c.id === selectedClient.id ? fn(c) : c)))
  }

  const createClient = () => {
    if (!newClientName.trim()) return
    const template = TEMPLATES.find((t) => t.name === templateName) ?? TEMPLATES[0]
    const client: Client = {
      id: crypto.randomUUID(),
      name: newClientName.trim(),
      goal: template.goal,
      dailyTarget: template.target,
      meals: template.meals.map((name) => ({ name, items: [] })),
      supplements: [],
      notes: '',
      checkIns: [],
    }
    setClients((prev) => [client, ...prev])
    setSelectedClientId(client.id)
    setNewClientName('')
  }

  const applyTemplateToCurrent = () => {
    const template = TEMPLATES.find((t) => t.name === templateName)
    if (!template) return
    updateClient((c) => ({
      ...c,
      goal: template.goal,
      dailyTarget: { ...template.target },
      meals: template.meals.map((name, idx) => ({ name, items: c.meals[idx]?.items ?? [] })),
    }))
  }

  const addFoodToMeal = (mealIndex: number, foodId: string) => {
    if (!foodId) return
    updateClient((c) => {
      const meals = [...c.meals]
      meals[mealIndex] = { ...meals[mealIndex], items: [...meals[mealIndex].items, { foodId, servings: 1 }] }
      return { ...c, meals }
    })
  }

  const updateMealServings = (mealIndex: number, itemIndex: number, servings: number) => {
    updateClient((c) => {
      const meals = [...c.meals]
      const items = [...meals[mealIndex].items]
      items[itemIndex] = { ...items[itemIndex], servings: clamp(servings) }
      meals[mealIndex] = { ...meals[mealIndex], items }
      return { ...c, meals }
    })
  }

  const removeMealItem = (mealIndex: number, itemIndex: number) => {
    updateClient((c) => {
      const meals = [...c.meals]
      meals[mealIndex] = { ...meals[mealIndex], items: meals[mealIndex].items.filter((_, i) => i !== itemIndex) }
      return { ...c, meals }
    })
  }

  const createFood = () => {
    if (!newFood.name.trim()) return
    const f: Food = {
      id: crypto.randomUUID(),
      name: newFood.name.trim(),
      serving: newFood.serving.trim() || '1 serving',
      macro: {
        calories: clamp(Number(newFood.calories)),
        protein: clamp(Number(newFood.protein)),
        carbs: clamp(Number(newFood.carbs)),
        fat: clamp(Number(newFood.fat)),
      },
    }
    setFoods((prev) => [f, ...prev])
    setNewFood({ name: '', serving: '', calories: '', protein: '', carbs: '', fat: '' })
  }

  const parseCsv = (text: string): Food[] => {
    const rows = text.split(/\r?\n/).filter(Boolean)
    if (!rows.length) return []
    const headers = rows[0].split(',').map((h) => h.trim().toLowerCase())
    const idx = {
      name: headers.indexOf('name'),
      serving: headers.indexOf('serving'),
      calories: headers.indexOf('calories'),
      protein: headers.indexOf('protein'),
      carbs: headers.indexOf('carbs'),
      fat: headers.indexOf('fat'),
    }
    return rows.slice(1).map((row) => {
      const cols = row.split(',').map((c) => c.trim())
      return {
        id: crypto.randomUUID(),
        name: cols[idx.name] || 'Unnamed Food',
        serving: cols[idx.serving] || '1 serving',
        macro: {
          calories: clamp(Number(cols[idx.calories] ?? 0)),
          protein: clamp(Number(cols[idx.protein] ?? 0)),
          carbs: clamp(Number(cols[idx.carbs] ?? 0)),
          fat: clamp(Number(cols[idx.fat] ?? 0)),
        },
      }
    })
  }

  const importFoodsCsv = async (file: File) => {
    const text = await file.text()
    const imported = parseCsv(text).filter((f) => f.name)
    if (!imported.length) return
    setFoods((prev) => [...imported, ...prev])
  }

  const exportFoodsCsv = () => {
    const lines = ['name,serving,calories,protein,carbs,fat']
    for (const f of foods) {
      lines.push(`${f.name},${f.serving},${f.macro.calories},${f.macro.protein},${f.macro.carbs},${f.macro.fat}`)
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'food-library.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const createSupplement = () => {
    if (!newSupplement.name.trim()) return
    setSupplements((prev) => [
      { id: crypto.randomUUID(), name: newSupplement.name.trim(), dose: newSupplement.dose || 'As directed', timing: newSupplement.timing || 'Anytime' },
      ...prev,
    ])
    setNewSupplement({ name: '', dose: '', timing: '' })
  }

  const toggleSupplement = (id: string) => {
    updateClient((c) => ({
      ...c,
      supplements: c.supplements.includes(id) ? c.supplements.filter((s) => s !== id) : [...c.supplements, id],
    }))
  }

  const addCheckIn = () => {
    const entry: CheckIn = {
      id: crypto.randomUUID(),
      date: checkInForm.date,
      weight: clamp(Number(checkInForm.weight)),
      waist: clamp(Number(checkInForm.waist)),
      compliance: clamp(Number(checkInForm.compliance), 1),
      notes: checkInForm.notes,
    }
    updateClient((c) => ({ ...c, checkIns: [entry, ...c.checkIns] }))
    setCheckInForm((p) => ({ ...p, weight: '', waist: '', notes: '' }))
  }

  const autoAdjustMacros = () => {
    if (!selectedClient || selectedClient.checkIns.length < 2) {
      alert('Need at least 2 check-ins first.')
      return
    }

    const recent = [...selectedClient.checkIns].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-3)
    const first = recent[0]
    const last = recent[recent.length - 1]
    const weightDelta = last.weight - first.weight
    const avgCompliance = recent.reduce((sum, r) => sum + r.compliance, 0) / recent.length

    updateClient((c) => {
      let calories = c.dailyTarget.calories
      if (avgCompliance >= 80) {
        if (c.goal.toLowerCase().includes('fat') && weightDelta >= -0.2) calories -= 150
        else if (c.goal.toLowerCase().includes('gain') && weightDelta <= 0.1) calories += 150
      }

      const delta = calories - c.dailyTarget.calories
      return {
        ...c,
        dailyTarget: {
          calories,
          protein: c.dailyTarget.protein,
          carbs: clamp(c.dailyTarget.carbs + delta / 6),
          fat: clamp(c.dailyTarget.fat + delta / 30),
        },
      }
    })
  }

  if (!selectedClient) return null

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>NutriPlan Pro — v2</h1>
          <p>Meal planning SaaS with templates, CSV food import/export, and check-in driven macro adjustments.</p>
        </div>
      </header>

      <section className="stats-grid">
        <article className="stat"><h3>Clients</h3><strong>{clients.length}</strong></article>
        <article className="stat"><h3>Foods</h3><strong>{foods.length}</strong></article>
        <article className="stat"><h3>Supplements</h3><strong>{supplements.length}</strong></article>
        <article className="stat"><h3>Planned Calories</h3><strong>{fmt(dayMacro.calories)}</strong></article>
      </section>

      <main className="layout">
        <aside className="panel">
          <h2>Clients</h2>
          <div className="stack">
            <input placeholder="Client name" value={newClientName} onChange={(e) => setNewClientName(e.target.value)} />
            <select value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
              {TEMPLATES.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
            <button onClick={createClient}>Create Client</button>
          </div>
          <div className="list">
            {clients.map((c) => (
              <button key={c.id} className={c.id === selectedClient.id ? 'list-item active' : 'list-item'} onClick={() => setSelectedClientId(c.id)}>
                <span>{c.name}</span>
                <small>{c.goal}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="panel wide">
          <div className="section-title">
            <h2>{selectedClient.name}'s Plan</h2>
            <div className="row">
              <select value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
                {TEMPLATES.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
              <button className="ghost" onClick={applyTemplateToCurrent}>Apply Template</button>
            </div>
          </div>

          <div className="targets">
            {(['calories', 'protein', 'carbs', 'fat'] as const).map((k) => {
              const pct = selectedClient.dailyTarget[k] ? Math.round((dayMacro[k] / selectedClient.dailyTarget[k]) * 100) : 0
              return (
                <div className="target-card" key={k}>
                  <span>{k.toUpperCase()}</span>
                  <strong>{fmt(dayMacro[k])} / {selectedClient.dailyTarget[k]}</strong>
                  <div className="meter"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
                </div>
              )
            })}
          </div>

          {selectedClient.meals.map((meal, mealIndex) => {
            const m = calcMealMacros(meal, foods)
            return (
              <div className="meal-card" key={meal.name + mealIndex}>
                <div className="meal-head">
                  <h3>{meal.name}</h3>
                  <p>{fmt(m.calories)} kcal • P {fmt(m.protein)} • C {fmt(m.carbs)} • F {fmt(m.fat)}</p>
                </div>
                <div className="row">
                  <select defaultValue="" onChange={(e) => addFoodToMeal(mealIndex, e.target.value)}>
                    <option value="" disabled>Add food</option>
                    {foods.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.serving})</option>)}
                  </select>
                </div>
                {meal.items.map((item, itemIndex) => {
                  const food = foods.find((f) => f.id === item.foodId)
                  if (!food) return null
                  return (
                    <div className="row compact" key={food.id + itemIndex}>
                      <div><strong>{food.name}</strong><small>{food.serving}</small></div>
                      <input type="number" min="0" step="0.25" value={item.servings} onChange={(e) => updateMealServings(mealIndex, itemIndex, Number(e.target.value))} />
                      <button className="danger" onClick={() => removeMealItem(mealIndex, itemIndex)}>Remove</button>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </section>

        <aside className="panel">
          <h2>Food Library</h2>
          <div className="food-form">
            <input placeholder="Food name" value={newFood.name} onChange={(e) => setNewFood((p) => ({ ...p, name: e.target.value }))} />
            <input placeholder="Serving" value={newFood.serving} onChange={(e) => setNewFood((p) => ({ ...p, serving: e.target.value }))} />
            <div className="macro-grid">
              <input placeholder="Kcal" value={newFood.calories} onChange={(e) => setNewFood((p) => ({ ...p, calories: e.target.value }))} />
              <input placeholder="Protein" value={newFood.protein} onChange={(e) => setNewFood((p) => ({ ...p, protein: e.target.value }))} />
              <input placeholder="Carbs" value={newFood.carbs} onChange={(e) => setNewFood((p) => ({ ...p, carbs: e.target.value }))} />
              <input placeholder="Fat" value={newFood.fat} onChange={(e) => setNewFood((p) => ({ ...p, fat: e.target.value }))} />
            </div>
            <button onClick={createFood}>Save Food</button>
            <div className="row">
              <button className="ghost" onClick={() => fileRef.current?.click()}>Import CSV</button>
              <button className="ghost" onClick={exportFoodsCsv}>Export CSV</button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (file) await importFoodsCsv(file)
                e.currentTarget.value = ''
              }}
            />
          </div>

          <h2>Supplements</h2>
          <div className="food-form">
            <input placeholder="Supplement name" value={newSupplement.name} onChange={(e) => setNewSupplement((p) => ({ ...p, name: e.target.value }))} />
            <input placeholder="Dose" value={newSupplement.dose} onChange={(e) => setNewSupplement((p) => ({ ...p, dose: e.target.value }))} />
            <input placeholder="Timing" value={newSupplement.timing} onChange={(e) => setNewSupplement((p) => ({ ...p, timing: e.target.value }))} />
            <button onClick={createSupplement}>Add Supplement</button>
          </div>
          <div className="list">
            {supplements.map((s) => (
              <label key={s.id} className="check-item">
                <input type="checkbox" checked={selectedClient.supplements.includes(s.id)} onChange={() => toggleSupplement(s.id)} />
                <span><strong>{s.name}</strong><small>{s.dose} • {s.timing}</small></span>
              </label>
            ))}
          </div>

          <h2 style={{ marginTop: 12 }}>Check-ins</h2>
          <div className="food-form">
            <div className="row">
              <input type="date" value={checkInForm.date} onChange={(e) => setCheckInForm((p) => ({ ...p, date: e.target.value }))} />
              <input placeholder="Weight" value={checkInForm.weight} onChange={(e) => setCheckInForm((p) => ({ ...p, weight: e.target.value }))} />
            </div>
            <div className="row">
              <input placeholder="Waist" value={checkInForm.waist} onChange={(e) => setCheckInForm((p) => ({ ...p, waist: e.target.value }))} />
              <input placeholder="Compliance %" value={checkInForm.compliance} onChange={(e) => setCheckInForm((p) => ({ ...p, compliance: e.target.value }))} />
            </div>
            <input placeholder="Notes" value={checkInForm.notes} onChange={(e) => setCheckInForm((p) => ({ ...p, notes: e.target.value }))} />
            <button onClick={addCheckIn}>Add Check-in</button>
            <button className="ghost" onClick={autoAdjustMacros}>Auto Adjust Macros</button>
          </div>
          <div className="list">
            {selectedClient.checkIns.slice(0, 6).map((c) => (
              <div key={c.id} className="list-item">
                <span>{c.date}</span>
                <small>Wt: {c.weight} | Waist: {c.waist} | Compliance: {c.compliance}%</small>
              </div>
            ))}
          </div>
        </aside>
      </main>
    </div>
  )
}

export default App
