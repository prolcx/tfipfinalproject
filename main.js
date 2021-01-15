//import
const express = require('express')
const morgan = require('morgan')
const secureEnv = require('secure-env')
const bodyParser = require('body-parser')
const fetch = require('node-fetch')
const withQuery = require('with-query').default
const sha1 = require('sha1')
const mysql = require('mysql2/promise')
const jwt = require('jsonwebtoken')
const passport = require('passport')
const LocalStrategy = require('passport-local').Strategy

const GoogleStrategy = require("passport-google-oauth20").Strategy;

const nodemailer = require('nodemailer')

//mongo seteup
const MongoClient = require('mongodb').MongoClient
const MONGO_URL = "mongodb+srv://david:david@cluster0.kse6x.mongodb.net/food?retryWrites=true&w=majority";
                
const mongoClient = new MongoClient(MONGO_URL,
    {useNewUrlParser: true, useUnifiedTopology: true})

//mongo database setup
const DATABASE = 'food'
const COLLECTION = 'nutrient'

//configure my sql
//credential
global.env = secureEnv({secret: 'secretPassword'})
const pool = mysql.createPool({
    user : global.env.MYSQL_USERNAME,
    password : global.env.MYSQL_PASSWORD,
    host : global.env.MYSQL_SERVER,
    port : global.env.MYSQL_SVR_PORT,
    database : global.env.MYSQL_SCHEMA,
    //sslmode : global.env.MYSQL_SSLMODE
})

//sql queries
const queryLogin = 'select * from login where username = ?'
const queryDashBoard = 'select * from nutrition where date = ? and username = ?'
const queryDashBoardProgress = `select sum(calories) as totalCalories, sum(saturated) as totalSaturated, 
    sum(trans) as totalTrans, sum(carbohydrates) as totalCarbohydrates, sum(sugar) as totalSugar, 
    sum(protein) as totalProtein, sum(caloriesNeeded) as caloriesPercent, sum(saturatedNeeded) as saturatedPercent, 
    sum(transNeeded) as transPercent, sum(carbsNeeded) as carbohydratesPercent, sum(sugarNeeded) as sugarPercent, 
    sum(proteinNeeded) as proteinPercent, round(sum(calories)/sum(caloriesNeeded)*100, 0) as dailyCalories, 
    round(sum(saturated)/sum(saturatedNeeded)*100, 0) as dailySaturated, round(sum(trans)/sum(transNeeded)*100, 0) as dailyTrans, 
    round(sum(carbohydrates)/sum(carbsNeeded)*100, 0) as dailyCarbohydrates, round(sum(sugar)/sum(sugarNeeded)*100, 0) as dailySugar, 
    round(sum(protein)/sum(proteinNeeded)*100, 0) as dailyProtein from nutrition where date= ? and username= ?`
const deleteDashBoard = 'delete from nutrition where id = ?'

//Processing SQL queries
const makeQuery = (sql, pool) =>{
	// console.log(sql)
	return (async (args)=>{
		const conn = await pool.getConnection()
		try{
			let results = await conn.query(sql, args || [])
			// console.log(results[0])
			return results[0]
		}catch(e){
			console.log(e)
		}finally{
			conn.release()
		}
	})
}

//close function for queries
const getLogin = makeQuery(queryLogin, pool)
const getDashBoardDaily = makeQuery(queryDashBoard, pool)
const getDashBoardProgress = makeQuery(queryDashBoardProgress, pool)
const deleteDashBoardFood = makeQuery(deleteDashBoard, pool)

//core and configure passport
passport.use(new LocalStrategy(
    {
        usernameField: 'username',
        passwordField: 'password',
        passReqToCallback: true
    },
    (req, user, password, done)=>{
        //mysql checking
        username = req.body.username
        password = sha1(req.body.password)
        
        getLogin(username).then((result)=>{
            // console.log(result)
            const authResult = (result[0].username== username && result[0].password == password)
            if (authResult) {
                done(null, 
                    //info about the user
                    {
                        username: user,
                        loginTime: (new Date()).toString(),
                        security: 2
                    })
                    return
            }
            //incorrect login
            done('incorrect usename and password', false)
        })
        .catch((e)=>{
            console.log('Username not found !')
            resp.status(401).json({message: 'Username not found'})
        })
    }
))

//configure google passport
passport.use(new GoogleStrategy({
    clientID: global.env.GOOGLE_CLIENT_ID,
    clientSecret: global.env.GOOGLE_CLIENT_SECRET,
    callbackURL: 'http://localhost:3001/auth/google/callback'
  },
  function(accessToken, refreshToken, profile, done) {

    console.info('Google profile: ', profile)

    getLogin(profile.emails[0].value).then((result)=>{
        if (result.length>0){
            done(null, profile)
        }
        else {
            const insertUser = async (username, password, email, gender) =>{
                const conn = await pool.getConnection()
                try{
                    await conn.beginTransaction()
                    await conn.query(`INSERT INTO login (username, password, email, gender) values (?, ?, ?, ?)`,
                        [username, password, email, gender] )
                    await conn.commit()
                    await done(null, profile)
                } catch(e){
                    conn.rollback()
                    console.info('mysql - newuser input rollback occurred')
                } finally {
                    conn.release()
                }
            }
            insertUser(profile.emails[0].value, sha1(profile.emails[0].value), profile.emails[0].value, 'notincluded')
        }
    })

  }
));

passport.serializeUser(function(user, done) {
    done(null, user);
  });
  
  passport.deserializeUser(function(user, done) {
    done(null, user);
  });

//configure express, morgan, body parser, secure-env, passport
const app = express()
app.use(morgan('combined'))
app.use(bodyParser.urlencoded({limit: '50mb', extended: true}))
app.use(bodyParser.json({limit: '50mb'}))
app.use(passport.initialize())

//setup port
const PORT = parseInt(process.argv[2]) || parseInt(process.env.PORT) || 3001

//API endpoints and details
const API_KEY = global.env.API_KEY || ""
const ENDPOINT_FOOD_SEARCH = 'https://api.spoonacular.com/food/menuItems/search'
const ENDPOINT_FOOD_ID_SEARCH = 'https://api.spoonacular.com/food/menuItems/'

//GET Request: Retrieve Progress data from mysql
app.get('/dashboard/progress/:date', (req, resp)=>{
    const date = req.params.date.slice(0, 19)
    const paramsLength = req.params.date.length
    const name = req.params.date.slice(19, paramsLength)

    console.log('>>>dashboard date read: ', date)

    getDashBoardProgress([date, name])
    .then(result=>{
        resp.status(200).json(result)
    })
})

//GET Request: Retrieve daily nutrient data from mysql
app.get('/dashboard/:date', (req, resp)=>{
    const date = req.params.date.slice(0, 19)
    const paramsLength = req.params.date.length
    const name = req.params.date.slice(19, paramsLength)

    console.log('>>>dashboard date read: ', date)

    getDashBoardDaily([date, name])
    .then(result=>{
        resp.status(200).json(result)
    })
})

//POST Request: Browse for food id
app.post('/', async (req, resp) => {
    const url = withQuery(
        ENDPOINT_FOOD_SEARCH, {
            query: req.body.foodName,
            number: 5,
            apiKey: API_KEY,
        })
    console.info(req.body)
    console.info(url)

    const a = await fetch(url)
    const foodSearch = await a.json()
    
    console.info(foodSearch)

    const result=[]
    for (let b of foodSearch.menuItems) {
        const id= b.id
        const title = b.title
        const restaurant = b.restaurantChain
        const imageUrl = b.image
        //save the data here
        result.push({id, title, restaurant, imageUrl})
    }

    resp.status(200)
    resp.json(result)
})

//POST Request: Browse food nutrient by id
app.post('/id', async (req, resp) => {

    foodNutrientResult = []
    for (let c of req.body) {

        //insert mongo search here, 
        //make sure mongo give the correct data type
        //use continue; pushing to foodNutrientSearch
        const mongoData = await mongoClient.db(DATABASE).collection(COLLECTION).find({id: c.id}).toArray()

        if(mongoData.length>0) {
            foodNutrientResult.push(mongoData[0])
            continue
        }

        else{
            const id= c.id
            const url = withQuery(
                ENDPOINT_FOOD_ID_SEARCH+id, {
                    apiKey: API_KEY,
                })
            console.info('search food by id url: ', url)
            
            const d = await fetch(url)
            const foodNutrientSearch = await d.json()
            
            console.info("foodNutrientSearch: ", foodNutrientSearch)
            
            // save the data here
            foodNutrientResult.push(foodNutrientSearch)
        }
    }    
    resp.status(200)
    resp.json(foodNutrientResult)
})

//POST Request: Save the daily diet into Mysql
app.post('/save', async (req, resp)=>{

    const todayFoodList = req.body

    const cacheData = todayFoodList.find(i => i.title === 'cache');
    const cacheDataIndex = todayFoodList.findIndex(i => i.title === 'cache')
    const storingFoodList = todayFoodList.slice(0, cacheDataIndex)
    const mongoCacheList = []
    
    // console.info('cacheData: ', cacheData)

    const insertTodo = async (storingFoodList) =>{
        const conn = await pool.getConnection()
        try{
            await conn.beginTransaction()
            
            for( let e of storingFoodList) {
            await conn.query(`INSERT INTO nutrition (food, calories, carbohydrates, fat, sugar, protein, cholesterol, 
                fiber, date, username, foodId, caloriesNeeded, carbsNeeded, fatNeeded, sugarNeeded, proteinNeeded, 
                cholesterolNeeded, fiberNeeded, saturatedNeeded, saturated, trans, transNeeded) 
                values (?, ?, ?, ?, ?, ?, ?, ? ,? ,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [e.title, e.calories, e.carbs, e.fat, e.sugar, e.protein,
                e.cholesterol, e.fiber, `${new Date().toJSON().slice(0, 10)} 00:00:00`, e.username, e.id, e.caloriesNeeded, 
                e.carbsNeeded, e.fatNeeded, e.sugarNeeded, e.proteinNeeded, e.cholesterolNeeded, e.fiberNeeded, e.saturatedNeeded, 
                e.saturated, e.trans, e.transNeeded] )
            }
            await conn.commit()
        } catch(e){
            conn.rollback()
            console.info('mysql rollback occurred')
        } finally {
            conn.release()
        }
    }
    
    for(let f of cacheData.array) {
    const mongoData = await mongoClient.db(DATABASE).collection(COLLECTION).find({id: f.id}).toArray()
    if (mongoData.length<=0)
        mongoCacheList.push(f)
    }
    
    // console.info('mongo cachelist array: ', mongoCacheList)
    const p2 = insertTodo(storingFoodList)     //to be removed after promise all is done
    const p3 = mongoClient.db(DATABASE).collection(COLLECTION).insertMany(mongoCacheList)

    Promise.all([p2,p3])
    .then(()=>{
        console.info('operation succeed')
    })
    .catch(err=>{ console.error('One of the insert (mysql / mondodb) failed: ', err)})
    
    resp.status(200).json({})
            
})

//POST Request: Login Authentication and Obtaining JSON Web Token
app.post('/login', 
    //custom middleware to handle request
    //passport.authenticate('local', { session: false}),
    (req, resp, next) =>{
        passport.authenticate('local',
        (err, user, info)=>{
            if (null != err) {
                resp.status(401)
                resp.json({error: err})
                return
            }
            console.info(`passport user: `, user)
            req.user=user;
            next()
        })
        (req, resp, next)
    },
    // passport.authenticate('local', { session: false}),
    (req,resp) =>{
        //do smth
        console.info(`user: `, req.user)
        //generate JWT token
        const currTime= (new Date()).getTime()/1000
        const token = jwt.sign({
            sub: 'req.user.username',
            iss: 'myapp',
            iat: currTime,
            // nbf: currTime,
            // exp: currTime + 1000000,
            data: {
                avatar: req.user.avatar,
                loginTime: req.user.loginTime
            }
        }, global.env.TOKEN_SECRET)
        resp.status(200)
        resp.type('application/json')
        resp.json({ message: `Login in at ${new Date()}`, token, username: req.user.username})
    }
)

//GET Request: Google Passport login route
app.get('/auth/google',
  passport.authenticate('google', { scope: ['email', 'profile'] })
  );

//GET Request: Google Callback Function
app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, resp)=> {
    //authorise token
    //set up new user in mongo
    //sign in with the existing user
    console.info(`google user: `, req.user)

    const currTime= (new Date()).getTime()/1000
        const token = jwt.sign({
            sub: 'req.user.username',
            iss: 'myapp',
            iat: currTime,
            // nbf: currTime,
            // exp: currTime + 1000000,
            data: {
                avatar: req.user.avatar,
                loginTime: req.user.loginTime
            }
        }, global.env.TOKEN_SECRET)
        
        let responseHTML = '<html><head><title>Main</title></head><body></body><script>res = %value%; window.opener.postMessage(res, "*");window.close();</script></html>'
        responseHTML = responseHTML.replace('%value%', JSON.stringify({
        user: req.user,
        token
    }));
    resp.status(200).send(responseHTML);
  });


//POST Request: Register a new account
app.post('/signup', async (req, resp, next) => {
  
    const username = req.body.username
    const password = sha1(req.body.password)
    const email = req.body.email
    const gender = req.body.gender

    const insertUser = async (username, password, email, gender) =>{
        const conn = await pool.getConnection()
        try{
            await conn.beginTransaction()
            await conn.query(`INSERT INTO login (username, password, email, gender) values (?, ?, ?, ?)`,
                [username, password, email, gender] )
            await conn.commit()
            await next()
        } catch(e){
            conn.rollback()
            console.info('mysql - newuser input rollback occurred')
        } finally {
            conn.release()
        }
    }
    insertUser(username, password, email, gender)
},
(req, resp)=>{
    var transporter = nodemailer.createTransport({
        service: global.env.HOST_EMAIL_SERVICE,
        auth: {
          user: global.env.HOST_EMAIL,
          pass: global.env.HOST_EMAIL_PASSWORD
        }
      });
      
    var mailOptions = {
    from: global.env.HOST_EMAIL,
    to: req.body.email,
    subject: 'Account Registered',
    text: `You just craeted a new account named "${req.body.username}" in the Food Lab!!`
    };
      
    transporter.sendMail(mailOptions, function(error, info){
    if (error) {
        console.log('Cant send email: ', error);
    } else {
        console.log('Email sent: ' + info.response);
    }
    });
    resp.status(200)
    resp.json({})
})

//DELETE Request: Deleting selected item in mysql via id
app.delete('/dashboard/delete/:id', (req, resp)=>{
    
    console.info('id to be deleted: ', req.params.id)
    deleteDashBoardFood(req.params.id)
   
    resp.status(200).json({})
    
})

app.use(express.static(__dirname + '/frontend'))

//test ping of my sql and mongo
const p0 = (async () => {
    
    const conn = await pool.getConnection()
    await conn.ping()
    conn.release()
    return true
})()
const p1 = mongoClient.connect()

Promise.all([p0,p1])
.then(()=>{
    app.listen(PORT,()=>{
        console.info(`Application started at ${PORT} at ${new Date()}`)
    })
})
.catch(err=>{ console.error('Cant connect to the port !!!!', err)})
